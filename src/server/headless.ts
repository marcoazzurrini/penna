import type { Browser, Page } from "playwright-core";
import { renderSubset, type NodeLookup } from "../shared/tree.ts";
import type { PennaDoc } from "../shared/types.ts";

export interface LayoutReport {
  width: number;
  height: number;
  /** [id, name, x, y, width, height] relative to the measured node. */
  nodes: [string, string, number, number, number, number][];
  problems: string[];
}

/** Renders a page or node of a document, for screenshots and layout checks. */
export interface Renderer {
  /** `id` is a page id or a node id. `index` finds the nodes of `doc`. */
  screenshot(doc: PennaDoc, index: NodeLookup, id: string, scale?: number): Promise<Buffer>;
  layout(doc: PennaDoc, index: NodeLookup, id: string): Promise<LayoutReport>;
}

interface PennaWindow {
  __penna: {
    /** `css` is null when the stylesheet sent last time still applies. */
    render(doc: PennaDoc, css: string | null, id: string, scale?: number): Promise<{ width: number; height: number }>;
    layout(doc: PennaDoc, css: string | null, id: string): Promise<LayoutReport>;
  };
}

/** How long one render may take before the browser is taken to be stuck. */
const JOB_TIMEOUT = 30_000;

/** A lazily started headless Chrome that renders documents with the same code as the viewer. */
export class Headless implements Renderer {
  private browser: Browser | null = null;
  private page: Promise<Page> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** The stylesheet the page has now. */
  private sentCss: string | null = null;
  /** Counts restarts, so a start that was overtaken by one can tell. */
  private generation = 0;
  private url: () => string;
  private css: (doc: PennaDoc) => string;
  /** Time limit per job in ms. Tests shorten it. */
  timeout = JOB_TIMEOUT;

  /** `css` returns the Tailwind stylesheet for a document that is about to be rendered. */
  constructor(url: () => string, css: (doc: PennaDoc) => string = () => "") {
    this.url = url;
    this.css = css;
  }

  private async start(): Promise<Page> {
    const generation = this.generation;
    const { chromium } = await import("playwright-core");
    let browser: Browser;
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        throw new Error("No Chrome found for screenshots. Install Google Chrome, or run: npx playwright install chromium");
      }
    }
    if (this.closed || generation !== this.generation) {
      // Closed or restarted while Chrome was starting. This browser is not wanted.
      await browser.close().catch(() => {});
      throw new Error(this.closed ? "The renderer was closed." : "The renderer was restarted.");
    }
    this.browser = browser;
    browser.on("disconnected", () => {
      if (this.browser === browser) this.reset();
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(this.url() + "/?headless=1");
    await page.waitForFunction(() => "__penna" in window);
    return page;
  }

  /** Forget the browser, so the next job starts a new one. */
  private reset() {
    this.generation++;
    this.browser = null;
    this.page = null;
    this.sentCss = null;
  }

  private ready(): Promise<Page> {
    if (!this.page) {
      const starting: Promise<Page> = this.start().catch((err) => {
        if (this.page === starting) this.page = null;
        throw err;
      });
      this.page = starting;
    }
    return this.page;
  }

  /**
   * Run jobs one at a time; they share a single page. A job that takes too long fails,
   * and the browser is restarted so the jobs behind it are not stuck too.
   */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const guarded = () => {
      let timer: NodeJS.Timeout;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const stuck = this.browser;
          this.reset();
          void stuck?.close().catch(() => {});
          reject(new Error(`Rendering took longer than ${this.timeout / 1000} s and was stopped.`));
        }, this.timeout);
      });
      return Promise.race([job(), late]).finally(() => clearTimeout(timer));
    };
    const next = this.queue.then(guarded, guarded);
    this.queue = next.catch(() => {});
    return next;
  }

  /** What to send to the page: only the nodes this render needs, and the stylesheet if it changed. */
  private payload(doc: PennaDoc, index: NodeLookup, id: string): { subset: PennaDoc; css: string | null; sent: string } {
    const subset = renderSubset(doc, index, id);
    const css = this.css(subset);
    return { subset, css: css === this.sentCss ? null : css, sent: css };
  }

  screenshot(doc: PennaDoc, index: NodeLookup, id: string, scale?: number): Promise<Buffer> {
    return this.serial(async () => {
      const page = await this.ready();
      const { subset, css, sent } = this.payload(doc, index, id);
      await page.evaluate(([d, c, n, s]) => (window as unknown as PennaWindow).__penna.render(d, c, n, s), [subset, css, id, scale] as const);
      this.sentCss = sent;
      return page.locator("#stage").screenshot({ type: "png", animations: "disabled" });
    });
  }

  layout(doc: PennaDoc, index: NodeLookup, id: string): Promise<LayoutReport> {
    return this.serial(async () => {
      const page = await this.ready();
      const { subset, css, sent } = this.payload(doc, index, id);
      const report = await page.evaluate(([d, c, n]) => (window as unknown as PennaWindow).__penna.layout(d, c, n), [subset, css, id] as const);
      this.sentCss = sent;
      return report;
    });
  }

  private closed = false;

  async close() {
    this.closed = true;
    // A browser that is still starting closes itself once it sees `closed`.
    await this.page?.catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
