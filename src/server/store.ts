import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { emptyDoc, type PennaDoc } from "../shared/types.ts";

const HISTORY_LIMIT = 50;

interface Entry {
  doc: PennaDoc;
  rev: number;
  /** Exact text we last wrote or read, so the watcher can ignore our own writes. */
  text: string;
  undo: string[];
  redo: string[];
}

export interface Selection {
  file: string;
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

export function validName(name: string): boolean {
  return /^[\w][\w.-]*$/.test(name) && !name.endsWith(".json");
}

/** Owns the documents in `.penna/`: loading, saving, undo history, and file watching. */
export class Store extends EventEmitter {
  readonly dir: string;
  private entries = new Map<string, Entry>();
  selection: Selection | null = null;
  viewing: { file: string; page: string } | null = null;
  /** Rendered sizes of top-level nodes, reported by the viewer. */
  sizes = new Map<string, [number, number]>();
  readonly root: string;

  constructor(root: string) {
    super();
    this.root = root;
    this.dir = path.join(root, ".penna");
  }

  ensureDir() {
    if (fs.existsSync(this.dir)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, ".gitignore"), ".server.json\n.shots/\n");
  }

  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  /** The file an agent call targets when it names none. */
  defaultFile(): string {
    if (this.viewing && this.list().includes(this.viewing.file)) return this.viewing.file;
    return this.list()[0] ?? "design";
  }

  private file(name: string) {
    return path.join(this.dir, name + ".json");
  }

  private load(name: string, create: boolean): Entry | undefined {
    if (!validName(name)) return undefined;
    const cached = this.entries.get(name);
    if (cached) return cached;
    const file = this.file(name);
    let text: string;
    let doc: PennaDoc;
    if (fs.existsSync(file)) {
      text = fs.readFileSync(file, "utf8");
      doc = JSON.parse(text) as PennaDoc;
    } else if (create) {
      doc = emptyDoc();
      text = "";
    } else {
      return undefined;
    }
    const entry: Entry = { doc, rev: 0, text, undo: [], redo: [] };
    this.entries.set(name, entry);
    return entry;
  }

  get(name: string): PennaDoc | undefined {
    return this.load(name, false)?.doc;
  }

  getOrCreate(name: string): PennaDoc {
    const entry = this.load(name, true);
    if (!entry) throw new Error(`Invalid file name "${name}". Use letters, numbers, - _ .`);
    return entry.doc;
  }

  rev(name: string): number {
    return this.entries.get(name)?.rev ?? 0;
  }

  /** Replace a document, record undo history, write it to disk, and notify listeners. */
  commit(name: string, doc: PennaDoc) {
    const entry = this.load(name, true);
    if (!entry) throw new Error(`Invalid file name "${name}".`);
    entry.undo.push(JSON.stringify(entry.doc));
    if (entry.undo.length > HISTORY_LIMIT) entry.undo.shift();
    entry.redo = [];
    this.replace(name, entry, doc);
  }

  undo(name: string): boolean {
    const entry = this.entries.get(name);
    const prev = entry?.undo.pop();
    if (!entry || !prev) return false;
    entry.redo.push(JSON.stringify(entry.doc));
    this.replace(name, entry, JSON.parse(prev));
    return true;
  }

  redo(name: string): boolean {
    const entry = this.entries.get(name);
    const next = entry?.redo.pop();
    if (!entry || !next) return false;
    entry.undo.push(JSON.stringify(entry.doc));
    this.replace(name, entry, JSON.parse(next));
    return true;
  }

  private replace(name: string, entry: Entry, doc: PennaDoc) {
    const isNew = !fs.existsSync(this.file(name));
    entry.text = JSON.stringify(doc, null, 1) + "\n";
    // Re-parse so the stored copy is plain data, free of objects from the snippet sandbox.
    entry.doc = JSON.parse(entry.text);
    entry.rev++;
    this.ensureDir();
    const tmp = this.file(name) + ".tmp";
    fs.writeFileSync(tmp, entry.text);
    fs.renameSync(tmp, this.file(name));
    this.emit("change", name);
    if (isNew) this.emit("files");
  }

  /** Pick up edits made outside penna, such as git checkouts or hand edits. */
  private watcher: fs.FSWatcher | null = null;
  private syncTimer: NodeJS.Timeout | undefined;

  watch() {
    this.ensureDir();
    this.watcher = fs.watch(this.dir, () => {
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
    const names = new Set(this.list());
    for (const [name, entry] of this.entries) {
      if (!names.has(name)) {
        if (entry.text) this.entries.delete(name);
        continue;
      }
      const text = fs.readFileSync(this.file(name), "utf8");
      if (text === entry.text) continue;
      try {
        entry.undo.push(JSON.stringify(entry.doc));
        entry.doc = JSON.parse(text);
        entry.text = text;
        entry.rev++;
        this.emit("change", name);
      } catch {
        // Half-written or invalid JSON. Keep the last good version.
        entry.undo.pop();
      }
    }
    this.emit("files");
  }
}
