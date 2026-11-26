import vm from "node:vm";
import type { LayoutReport, Renderer } from "./headless.ts";
import { Icons } from "./icons.ts";
import { randomId } from "./normalize.ts";
import { Session } from "./session.ts";
import type { Store } from "./store.ts";

export interface Edit {
  find: string;
  replace: string;
  all?: boolean;
}

export interface ExecRequest {
  code?: string;
  editId?: string;
  edits?: Edit[];
}

export interface Shot {
  id: string;
  name: string;
  png: Buffer;
}

export interface ExecResult {
  ok: boolean;
  /** Print output, created ids, warnings, and errors, ready to show the agent. */
  text: string;
  editId?: string;
  shots: Shot[];
}

/** Longest the snippet may run before its first `await`, which catches most endless loops. */
const SYNC_LIMIT = 5000;
/** Longest a whole snippet may take, including the time it waits on Layout. */
const TOTAL_LIMIT = 60_000;

/**
 * Runs agent snippets against a working copy of the document and commits on success.
 * Calls run one at a time, in the order they arrive: each sees the result of the one
 * before, so concurrent callers cannot overwrite each other's work.
 */
export class Executor {
  private failed = new Map<string, string>();
  /** Globals assigned by snippets persist here between calls. */
  private ctx = vm.createContext({});
  private queue: Promise<unknown> = Promise.resolve();
  /** Called just before a change is committed, with the page the snippet worked on. */
  onCommit?: (page: string) => void;
  /** Time limits in ms. Tests shorten them. */
  limits = { sync: SYNC_LIMIT, total: TOTAL_LIMIT };

  private store: Store;
  private renderer: Renderer;
  private icons: Icons;
  private url: () => string;

  constructor(store: Store, renderer: Renderer, iconDir: string, url: () => string) {
    this.store = store;
    this.renderer = renderer;
    this.icons = new Icons(iconDir);
    this.url = url;
  }

  run(req: ExecRequest): Promise<ExecResult> {
    const result = this.queue.then(() => this.runNow(req));
    this.queue = result.catch(() => {});
    return result;
  }

  private async runNow(req: ExecRequest): Promise<ExecResult> {
    let code = req.code ?? "";
    if (req.editId) {
      const prev = this.failed.get(req.editId);
      if (prev === undefined) {
        return { ok: false, text: `Unknown editId "${req.editId}". Send the full snippet as code instead.`, shots: [] };
      }
      code = prev;
      for (const e of req.edits ?? []) {
        if (!e.find) return this.fail(req.editId, code, "Edit failed: find is empty.");
        const count = code.split(e.find).length - 1;
        if (count === 0) return this.fail(req.editId, code, `Edit failed: text not found: ${JSON.stringify(e.find.slice(0, 80))}`);
        if (count > 1 && !e.all) return this.fail(req.editId, code, `Edit failed: text found ${count} times; make it unique or set all:true: ${JSON.stringify(e.find.slice(0, 80))}`);
        code = e.all ? code.split(e.find).join(e.replace) : code.replace(e.find, () => e.replace);
      }
    }
    if (!code.trim()) return { ok: false, text: "Empty snippet.", shots: [] };

    const session = new Session(this.store, this.icons, this.renderer);
    try {
      await this.evaluate(code, session);
      if (process.env.PENNA_VERIFY_INDEX) session.work.verify();
      if (session.changed) {
        this.onCommit?.(session.work.pageId);
        this.store.commit(session.doc, session.work.touched);
      }
    } catch (err) {
      let message = formatError(err);
      if (message.startsWith("ReferenceError")) message += ". Globals are listed in the penna skill (read_skill tool, or `penna skill`).";
      return this.fail(req.editId, code, message, session);
    } finally {
      session.close();
    }
    if (req.editId) this.failed.delete(req.editId);
    for (const p of this.store.problems()) session.warn(p);

    const shots: Shot[] = [];
    if (session.shotJobs.length || session.checkJobs.length) {
      const doc = session.doc;
      try {
        for (const job of session.shotJobs) {
          for (const id of job.ids) {
            const png = await this.renderer.screenshot(doc, session.work, id, job.scale);
            shots.push({ id, name: session.nameOf(id), png });
          }
        }
        for (const id of session.checkJobs) {
          const report = await this.renderer.layout(doc, session.work, id);
          session.print(formatProblems(session.nameOf(id), report));
        }
      } catch (err) {
        session.warn(`Rendering failed: ${(err as Error).message}`);
      }
    }
    return { ok: true, text: session.summary(this.url()), shots };
  }

  /**
   * Run the snippet to its end. Rejects if it throws, loops before its first `await`,
   * or does not finish in time, for example because it waits on a promise that never
   * settles.
   *
   * One case is out of reach: an endless loop after an `await` holds the event loop, so
   * no timer can fire. Node can stop such code (a vm context with its own microtask
   * queue puts it under the time limit), but stopping a promise job aborts the whole
   * process when async hooks are on, which Playwright turns on in Node 22. Stopping it
   * safely needs the snippet to run in a worker thread.
   */
  private evaluate(code: string, session: Session): Promise<void> {
    const { sync, total } = this.limits;
    let timer: NodeJS.Timeout;
    return new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The snippet did not finish within ${total / 1000} s. It may be waiting on a promise that never settles.`)),
        total,
      );
      // The API is passed as arguments, so each run keeps its own functions for as long
      // as its code lives. `page` is a global getter, so it follows Page(name).
      const api = session.api();
      Object.defineProperties(this.ctx, {
        page: { get: () => session.work.pageId, configurable: true, enumerable: true },
        __pennaApi: { value: Object.values(api), configurable: true },
      });
      const source = `(function (${Object.keys(api).join(", ")}) { return (async () => {\n${code}\n})(); })(...__pennaApi)`;
      const script = new vm.Script(source, { filename: "snippet.js", lineOffset: -1 });
      (script.runInContext(this.ctx, { timeout: sync }) as Promise<unknown>).then(() => resolve(), reject);
    }).finally(() => clearTimeout(timer));
  }

  private fail(editId: string | undefined, code: string, message: string, session?: Session): ExecResult {
    const id = editId ?? randomId(6);
    this.failed.set(id, code);
    if (this.failed.size > 50) this.failed.delete(this.failed.keys().next().value!);
    const out = session?.outputLines.length ? "\nOutput before the error:\n" + session.outputLines.join("\n") : "";
    return {
      ok: false,
      editId: id,
      text: `Error: ${message}\nNothing was changed. Fix it by calling execute with editId "${id}" and edits.${out}`,
      shots: [],
    };
  }
}

function formatError(err: unknown): string {
  // Errors thrown by snippet code come from the sandbox realm, so instanceof Error fails.
  if (!err || typeof err !== "object" || !("message" in err)) return String(err);
  const e = err as { message: string; name?: string; stack?: string; code?: string };
  if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return `The snippet ran for too long (${e.message.match(/\d+ms/)?.[0] ?? "time limit"}). Look for a loop that never ends.`;
  const m = e.stack?.match(/snippet\.js:(\d+)/);
  const prefix = e.name && e.name !== "Error" ? e.name + ": " : "";
  return prefix + e.message + (m ? ` (line ${m[1]})` : "");
}

function formatProblems(name: string, r: LayoutReport): string {
  if (!r.problems.length) return `Check ${name}: no layout problems (${r.width}×${r.height}).`;
  return `Check ${name} (${r.width}×${r.height}): ${r.problems.length} problem(s)\n` + r.problems.map((p) => "  " + p).join("\n");
}
