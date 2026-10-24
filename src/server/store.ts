import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { emptyDoc, type PageFile, type PennaDoc, type ProjectFile } from "../shared/types.ts";

const HISTORY_LIMIT = 50;
const PROJECT = "project.json";

/** File contents keyed by path relative to `.penna/`. `null` means the file does not exist. */
type Snapshot = Map<string, string | null>;

export interface Selection {
  page: string;
  ids: string[];
}

/** Find the project root: the nearest ancestor with a .penna folder, else `cwd`. */
export function findRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".penna"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

/** Page ids double as file names, so keep them to safe characters. */
export function validId(id: string): boolean {
  return /^[\w][\w.-]*$/.test(id) && !id.endsWith(".json");
}

/** A readable, unique page id from a page name: "Sign in" becomes "sign-in". */
export function pageSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  return id;
}

const pageFile = (id: string) => `pages/${id}.json`;
const toText = (data: unknown) => JSON.stringify(data, null, 1) + "\n";

/**
 * Owns the project's design in `.penna/`: `project.json` holds variables, themes, and
 * page order; each page lives in `pages/<id>.json`. Agents and the viewer see one
 * document. Writes touch only the files that changed.
 */
export class Store extends EventEmitter {
  readonly root: string;
  readonly dir: string;
  private doc: PennaDoc | null = null;
  /** What each file held when we last wrote or read it. */
  private texts: Snapshot = new Map();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  rev = 0;
  selection: Selection | null = null;
  /** The page open in the viewer. */
  viewing: string | null = null;
  /** Rendered sizes of top-level nodes, reported by the viewer. */
  sizes = new Map<string, [number, number]>();

  constructor(root: string) {
    super();
    this.root = root;
    this.dir = path.join(root, ".penna");
  }

  ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, ".gitignore"), ".server.json\n.shots/\n");
    }
  }

  /** The whole project. Loaded on first use; empty until something is committed. */
  get(): PennaDoc {
    if (!this.doc) {
      this.migrate();
      this.texts = this.readAll();
      this.doc = this.assemble();
    }
    return this.doc;
  }

  /** Save a new version of the project, recording undo history. */
  commit(doc: PennaDoc) {
    this.get();
    const prev = this.write(this.serialize(doc));
    if (!prev.size) return;
    this.undoStack.push(prev);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
  }

  undo(): boolean {
    return this.step(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.step(this.redoStack, this.undoStack);
  }

  private step(from: Snapshot[], to: Snapshot[]): boolean {
    const snap = from.pop();
    if (!snap) return false;
    to.push(this.write(snap));
    this.changed();
    return true;
  }

  private changed() {
    // Re-assemble from the written text so the stored copy is plain data, free of
    // objects from the snippet sandbox.
    this.doc = this.assemble();
    this.rev++;
    this.emit("change");
  }

  /** Write the files whose contents differ. Returns their previous contents, for undo. */
  private write(next: Snapshot): Snapshot {
    const prev: Snapshot = new Map();
    for (const [rel, text] of next) {
      const cur = this.texts.get(rel) ?? null;
      if (cur === text) continue;
      prev.set(rel, cur);
      const file = path.join(this.dir, rel);
      if (text === null) {
        fs.rmSync(file, { force: true });
        this.texts.delete(rel);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + ".tmp", text);
        fs.renameSync(file + ".tmp", file);
        this.texts.set(rel, text);
      }
    }
    if (prev.size && !fs.existsSync(path.join(this.dir, ".gitignore"))) {
      fs.writeFileSync(path.join(this.dir, ".gitignore"), ".server.json\n.shots/\n");
    }
    return prev;
  }

  /** The file contents for `doc`, including deletions of pages that no longer exist. */
  private serialize(doc: PennaDoc): Snapshot {
    const out: Snapshot = new Map();
    for (const rel of this.texts.keys()) if (rel.startsWith("pages/")) out.set(rel, null);
    const project: ProjectFile = { version: 2, pages: doc.pages.map((p) => p.id) };
    if (doc.variables && Object.keys(doc.variables).length) project.variables = doc.variables;
    if (doc.themes && Object.keys(doc.themes).length) project.themes = doc.themes;
    out.set(PROJECT, toText(project));
    for (const p of doc.pages) {
      if (!validId(p.id)) throw new Error(`Invalid page id "${p.id}".`);
      const page: PageFile = { version: 2, name: p.name, children: p.children };
      out.set(pageFile(p.id), toText(page));
    }
    return out;
  }

  /** Build the document from `texts`. Pages missing from project.json come last, by id. */
  private assemble(): PennaDoc {
    const project = this.parse<ProjectFile>(PROJECT);
    const ids = [...this.texts.keys()].filter((r) => r.startsWith("pages/")).map((r) => r.slice(6, -5));
    const order = (project?.pages ?? []).filter((id) => ids.includes(id));
    const rest = ids.filter((id) => !order.includes(id)).sort();
    const pages = [...order, ...rest].flatMap((id) => {
      const page = this.parse<PageFile>(pageFile(id));
      return page ? [{ id, name: page.name ?? id, children: page.children ?? [] }] : [];
    });
    if (!pages.length) return { ...emptyDoc(), variables: project?.variables ?? {}, themes: project?.themes };
    return { version: 2, variables: project?.variables ?? {}, themes: project?.themes, pages };
  }

  private parse<T>(rel: string): T | undefined {
    const text = this.texts.get(rel);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  private readAll(): Snapshot {
    const out: Snapshot = new Map();
    const read = (rel: string) => {
      try {
        out.set(rel, fs.readFileSync(path.join(this.dir, rel), "utf8"));
      } catch {}
    };
    read(PROJECT);
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(this.dir, "pages"));
    } catch {}
    for (const f of names) if (f.endsWith(".json") && validId(f.slice(0, -5))) read(pageFile(f.slice(0, -5)));
    return out;
  }

  /**
   * penna 0.1 kept several files in `.penna/`, each with its own pages. Merge them into
   * the project layout once, and keep the originals in `.penna/.v1-backup/`.
   */
  private migrate() {
    if (!fs.existsSync(this.dir) || fs.existsSync(path.join(this.dir, PROJECT))) return;
    const old = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
    const docs: { version: 1; pages: { id: string; name: string; children: PageFile["children"] }[]; variables?: Record<string, string>; themes?: ProjectFile["themes"] }[] = [];
    for (const f of old) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        if (d && d.version === 1 && Array.isArray(d.pages)) docs.push(d);
      } catch {}
    }
    if (!docs.length) return;
    const doc: PennaDoc = { version: 2, variables: {}, pages: [] };
    for (const d of docs) {
      Object.assign(doc.variables!, d.variables ?? {});
      for (const t in d.themes ?? {}) (doc.themes ??= {})[t] = { ...(doc.themes?.[t] ?? {}), ...d.themes![t] };
      for (const p of d.pages) doc.pages.push({ id: pageSlug(p.name, doc.pages.map((x) => x.id)), name: p.name, children: p.children });
    }
    this.texts = new Map();
    this.write(this.serialize(doc));
    const backup = path.join(this.dir, ".v1-backup");
    fs.mkdirSync(backup, { recursive: true });
    for (const f of old) fs.renameSync(path.join(this.dir, f), path.join(backup, f));
  }

  /** Pick up edits made outside penna, such as git checkouts or hand edits. */
  private watcher: fs.FSWatcher | null = null;
  private syncTimer: NodeJS.Timeout | undefined;

  watch() {
    this.ensureDir();
    this.get();
    this.watcher = fs.watch(this.dir, { recursive: true }, (_event, name) => {
      if (name && String(name).split(path.sep).some((s) => s.startsWith("."))) return;
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => this.sync(), 60);
    });
  }

  unwatch() {
    clearTimeout(this.syncTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private sync() {
    const disk = this.readAll();
    const prev: Snapshot = new Map();
    for (const rel of new Set([...this.texts.keys(), ...disk.keys()])) {
      const text = disk.get(rel) ?? null;
      const cur = this.texts.get(rel) ?? null;
      if (text === cur) continue;
      if (text !== null) {
        try {
          JSON.parse(text);
        } catch {
          continue; // Half-written or invalid JSON. Keep the last good version.
        }
      }
      prev.set(rel, cur);
      if (text === null) this.texts.delete(rel);
      else this.texts.set(rel, text);
    }
    if (!prev.size) return;
    this.undoStack.push(prev);
    this.changed();
  }
}
