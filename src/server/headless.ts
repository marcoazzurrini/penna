import type { Browser, Page } from "playwright-core";
import type { PennaDoc } from "../shared/types.ts";

export interface LayoutReport {
  width: number;
  height: number;
  /** [id, name, x, y, width, height] relative to the measured node. */
  nodes: [string, string, number, number, number, number][];
  problems: string[];
}

interface PennaWindow {
  __penna: {
    render(doc: PennaDoc, page: string, id: string, scale?: number): Promise<{ width: number; height: number }>;
    layout(doc: PennaDoc, page: string, id: string): Promise<LayoutReport>;
  };
}

/** A lazily started headless Chrome that renders documents with the same code as the viewer. */
export class Headless {
  private browser: Browser | null = null;
  private page: Promise<Page> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private url: () => string;

  constructor(url: () => string) {
    this.url = url;
  }

  private async start(): Promise<Page> {
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
    this.browser = browser;
    browser.on("disconnected", () => {
      this.browser = null;
      this.page = null;
    });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(this.url() + "/?headless=1");
    await page.waitForFunction(() => "__penna" in window);
    return page;
  }

  private ready(): Promise<Page> {
    this.page ??= this.start().catch((err) => {
      this.page = null;
      throw err;
    });
    return this.page;
  }

  /** Run jobs one at a time; they share a single page. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  screenshot(doc: PennaDoc, pageId: string, nodeId: string, scale?: number): Promise<Buffer> {
    return this.serial(async () => {
      const page = await this.ready();
      await page.evaluate(
        ([d, p, id, s]) => (window as unknown as PennaWindow).__penna.render(d, p, id, s),
        [doc, pageId, nodeId, scale] as const,
      );
      return page.locator("#stage").screenshot({ type: "png", animations: "disabled" });
    });
  }

  layout(doc: PennaDoc, pageId: string, nodeId: string): Promise<LayoutReport> {
    return this.serial(async () => {
      const page = await this.ready();
      return page.evaluate(
        ([d, p, id]) => (window as unknown as PennaWindow).__penna.layout(d, p, id),
        [doc, pageId, nodeId] as const,
      );
    });
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }
}
