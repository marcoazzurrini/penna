import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { pageFileProblem, projectFileProblem } from "../shared/schema.ts";
import { emptyDoc, type PageFile, type PennaDoc, type PennaPage, type ProjectFile } from "../shared/types.ts";

const HISTORY_LIMIT = 50;
const PROJECT = "project.json";

/** File contents keyed by path relative to `.penna/`. `null` means the file does not exist. */
type Snapshot = Map<string, string | null>;

export interface Selection {
  page: string;
  ids: string[];
}

/**
 * Find the project root: the nearest ancestor with a .penna folder. The search stops at
 * the git root, so a worktree inside another checkout never uses that checkout's canvas.
 * Without a .penna folder, the root is the git root, else `cwd`.
 */
export function findRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".penna"))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
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
const GITIGNORE = ".server.json\n.shots/\n";

/** The page id for a path like `pages/home.json`, or null for any other path. */
function pageIdOf(rel: string): string | null {
  if (!rel.startsWith("pages/") || !rel.endsWith(".json")) return null;
  const id = rel.slice(6, -5);
  return validId(id) ? id : null;
}

const isDesignFile = (rel: string) => rel === PROJECT || pageIdOf(rel) !== null;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k in v) deepFreeze(v[k]);
  }
  return v;
}

/** Parse and check one design file. Returns its data, or what is wrong with it. */
function check(rel: string, text: string): { data: unknown } | { problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const conflict = /^(<<<<<<<|=======|>>>>>>>)/m.test(text);
    return { problem: conflict ? "it has git conflict markers" : `it is not valid JSON (${(err as Error).message})` };
  }
  const problem = rel === PROJECT ? projectFileProblem(data) : pageFileProblem(data);
  return problem ? { problem } : { data };
}

/**
 * Owns the project's design in `.penna/`: `project.json` holds variables, themes, keyframes, and
 * page order; each page lives in `pages/<id>.json`. Agents and the viewer see one
 * document. Writes touch only the files that changed.
 *
 * The document returned by `get()` is frozen. Pages keep their object identity until
 * their file changes, so callers can cache work per page.
 *
 * A file that is not a valid design (a merge conflict, a bad hand edit) is "broken":
 * the last good version stays in use when there is one, the problem is reported by
 * `problems()`, and penna never overwrites or deletes the file.
 */
export class Store extends EventEmitter {
  readonly root: string;
  readonly dir: string;
  private doc: PennaDoc | null = null;
  /** The last valid contents of each design file. */
  private texts = new Map<string, string>();
  /** The frozen, parsed form of each entry in `texts`. */
  private parsed = new Map<string, unknown>();
  /** Page objects built from `parsed`, by page id. */
  private pages = new Map<string, PennaPage>();
  /** Files on disk that are not valid designs, with the text that was rejected. */
  private broken = new Map<string, { text: string; problem: string }>();
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
      fs.writeFileSync(path.join(this.dir, ".gitignore"), GITIGNORE);
    }
  }

  /** The whole project. Loaded on first use; empty until something is committed. */
  get(): PennaDoc {
    if (!this.doc) {
      this.migrate();
      for (const [rel, text] of this.read()) if (text !== null) this.accept(rel, text);
      this.doc = this.assemble();
    }
    return this.doc;
  }

  /** One line for each broken file, saying what is wrong with it. */
  problems(): string[] {
    return [...this.broken].map(([rel, b]) => `.penna/${rel} is ignored: ${b.problem}. Fix or delete the file.`);
  }

  /** Page ids that belong to broken files, so new pages must not use them. */
  reservedPageIds(): string[] {
    return [...this.broken.keys()].flatMap((rel) => pageIdOf(rel) ?? []);
  }

  /**
   * Save a new version of the project, recording undo history. `touched` lists the ids
   * of the pages whose contents may differ from the stored ones; other pages are not
   * serialized again. Omit it to compare every page.
   */
  commit(doc: PennaDoc, touched?: ReadonlySet<string>) {
    this.get();
    const prev = this.write(this.serialize(doc, touched));
    if (!prev.size) return;
    this.pushUndo(prev);
    this.redoStack = [];
    this.changed(prev);
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
    let prev: Snapshot;
    try {
      prev = this.write(snap);
    } catch {
      // A file the step would change is broken on disk. Keep the history as it was.
      from.push(snap);
      return false;
    }
    to.push(prev);
    this.changed(prev);
    return true;
  }

  private pushUndo(prev: Snapshot) {
    this.undoStack.push(prev);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
  }

  /** `files` are the paths, relative to `.penna/`, whose contents changed. */
  private changed(files: Snapshot) {
    this.doc = this.assemble();
    this.rev++;
    this.emit("change", new Set(files.keys()));
  }

  /** Take `text` as the contents of `rel` if it is a valid design. Returns the problem if not. */
  private accept(rel: string, text: string): string | null {
    const result = check(rel, text);
    if ("problem" in result) {
      this.broken.set(rel, { text, problem: result.problem });
      return result.problem;
    }
    this.broken.delete(rel);
    this.keep(rel, text, result.data);
    return null;
  }

  private keep(rel: string, text: string, data: unknown) {
    this.texts.set(rel, text);
    // Parsed from text, so the stored copy is plain data, free of objects from the
    // snippet sandbox. Frozen, because sessions share it until they change a page.
    this.parsed.set(rel, deepFreeze(data));
    const id = pageIdOf(rel);
    if (id) this.pages.delete(id);
  }

  private forget(rel: string) {
    this.texts.delete(rel);
    this.parsed.delete(rel);
    const id = pageIdOf(rel);
    if (id) this.pages.delete(id);
  }

  /**
   * Write the files whose contents differ. Returns their previous contents, for undo.
   * Throws before writing anything if a file is broken on disk or the new contents are
   * not a valid design.
   */
  private write(next: Snapshot): Snapshot {
    const changes: { rel: string; text: string | null; cur: string | null; data?: unknown }[] = [];
    for (const [rel, text] of next) {
      const cur = this.texts.get(rel) ?? null;
      if (cur === text) continue;
      const bad = this.broken.get(rel);
      if (bad) throw new Error(`.penna/${rel} is broken (${bad.problem}) and penna will not overwrite it. Fix or delete the file, then try again.`);
      if (text === null) changes.push({ rel, text, cur });
      else {
        const result = check(rel, text);
        if ("problem" in result) throw new Error(`Refusing to save an invalid design to .penna/${rel}: ${result.problem}.`);
        changes.push({ rel, text, cur, data: result.data });
      }
    }
    const prev: Snapshot = new Map();
    for (const { rel, text, cur, data } of changes) {
      prev.set(rel, cur);
      const file = path.join(this.dir, rel);
      if (text === null) {
        fs.rmSync(file, { force: true });
        this.forget(rel);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + ".tmp", text);
        fs.renameSync(file + ".tmp", file);
        this.keep(rel, text, data);
      }
    }
    if (prev.size && !fs.existsSync(path.join(this.dir, ".gitignore"))) {
      fs.writeFileSync(path.join(this.dir, ".gitignore"), GITIGNORE);
    }
    return prev;
  }

  /** The file contents for `doc`, including deletions of pages that no longer exist. */
  private serialize(doc: PennaDoc, touched?: ReadonlySet<string>): Snapshot {
    const out: Snapshot = new Map();
    const ids = new Set(doc.pages.map((p) => p.id));
    for (const rel of this.texts.keys()) {
      const id = pageIdOf(rel);
      if (id && !ids.has(id)) out.set(rel, null);
    }
    const project: ProjectFile = { version: 2, pages: doc.pages.map((p) => p.id) };
    if (doc.variables && Object.keys(doc.variables).length) project.variables = doc.variables;
    if (doc.themes && Object.keys(doc.themes).length) project.themes = doc.themes;
    if (doc.keyframes && Object.keys(doc.keyframes).length) project.keyframes = doc.keyframes;
    out.set(PROJECT, toText(project));
    for (const p of doc.pages) {
      if (!validId(p.id)) throw new Error(`Invalid page id "${p.id}".`);
      const rel = pageFile(p.id);
      if (touched && !touched.has(p.id) && this.texts.has(rel)) continue;
      const page: PageFile = { version: 2, name: p.name, children: p.children };
      out.set(rel, toText(page));
    }
    return out;
  }

  /** Build the document from the stored files. Pages missing from project.json come last, by id. */
  private assemble(): PennaDoc {
    const project = this.parsed.get(PROJECT) as ProjectFile | undefined;
    const ids = [...this.texts.keys()].flatMap((rel) => pageIdOf(rel) ?? []);
    const have = new Set(ids);
    const order = (project?.pages ?? []).filter((id) => have.has(id));
    const ordered = new Set(order);
    const rest = ids.filter((id) => !ordered.has(id)).sort();
    const pages = [...new Set(order), ...rest].map((id) => this.page(id));
    const base = pages.length ? { version: 2 as const, pages } : emptyDoc();
    return deepFreeze({ ...base, variables: project?.variables ?? {}, themes: project?.themes, keyframes: project?.keyframes });
  }

  private page(id: string): PennaPage {
    let page = this.pages.get(id);
    if (!page) {
      const file = this.parsed.get(pageFile(id)) as Partial<PageFile>;
      page = Object.freeze({ id, name: file.name ?? id, children: file.children ?? (Object.freeze([]) as unknown as PennaPage["children"]) });
      this.pages.set(id, page);
    }
    return page;
  }

  /** The contents of the given design files on disk, or of all of them. `null` means missing. */
  private read(only?: Iterable<string>): Snapshot {
    const out: Snapshot = new Map();
    const read = (rel: string) => {
      try {
        out.set(rel, fs.readFileSync(path.join(this.dir, rel), "utf8"));
      } catch {
        out.set(rel, null);
      }
    };
    if (only) {
      for (const rel of only) read(rel);
      return out;
    }
    read(PROJECT);
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(this.dir, "pages"));
    } catch {}
    for (const f of names) if (pageIdOf("pages/" + f)) read("pages/" + f);
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
      for (const p of d.pages) doc.pages.push({ id: pageSlug(String(p.name), doc.pages.map((x) => x.id)), name: p.name, children: p.children });
    }
    try {
      this.write(this.serialize(doc));
    } catch (err) {
      // Leave the old files alone when they do not hold a valid design.
      this.broken.set(old.join(", "), { text: "", problem: `the penna 0.1 files could not be migrated: ${(err as Error).message}` });
      return;
    }
    const backup = path.join(this.dir, ".v1-backup");
    fs.mkdirSync(backup, { recursive: true });
    for (const f of old) fs.renameSync(path.join(this.dir, f), path.join(backup, f));
  }

  /** Pick up edits made outside penna, such as git checkouts or hand edits. */
  private watcher: fs.FSWatcher | null = null;
  private syncTimer: NodeJS.Timeout | undefined;
  /** Files reported by the watcher since the last sync, or "all" when unsure. */
  private pending: Set<string> | "all" = new Set();

  watch() {
    this.ensureDir();
    this.get();
    this.watcher = fs.watch(this.dir, { recursive: true }, (_event, name) => {
      const rel = name ? String(name).split(path.sep).join("/") : "";
      if (rel.split("/").some((s) => s.startsWith("."))) return;
      if (isDesignFile(rel)) {
        if (this.pending !== "all") this.pending.add(rel);
      } else if (!rel || !path.extname(rel)) {
        // No name, or a folder (a checkout can replace all of `pages/`): look at everything.
        this.pending = "all";
      } else return;
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => {
        const only = this.pending === "all" ? undefined : this.pending;
        this.pending = new Set();
        this.sync(only);
      }, 60);
    });
  }

  unwatch() {
    clearTimeout(this.syncTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Bring the store in line with the files on disk. `only` limits the check to those
   * paths (relative to `.penna/`); omit it to check every design file. An external
   * change becomes one undo step and clears redo, like any other edit.
   */
  sync(only?: Iterable<string>) {
    this.get();
    const disk = this.read(only);
    const rels = only ? [...disk.keys()] : new Set([...this.texts.keys(), ...this.broken.keys(), ...disk.keys()]);
    const prev: Snapshot = new Map();
    let problemsChanged = false;
    for (const rel of rels) {
      if (!isDesignFile(rel)) continue;
      const text = disk.get(rel) ?? null;
      const cur = this.texts.get(rel) ?? null;
      const bad = this.broken.get(rel);
      if (text === null) {
        if (bad) problemsChanged = this.broken.delete(rel);
        if (cur === null) continue;
        prev.set(rel, cur);
        this.forget(rel);
      } else if (text === cur) {
        if (bad) problemsChanged = this.broken.delete(rel);
      } else if (bad?.text === text) {
        continue; // Still broken in the same way.
      } else {
        problemsChanged ||= !!bad;
        if (this.accept(rel, text)) problemsChanged = true;
        else prev.set(rel, cur);
      }
    }
    if (!prev.size && !problemsChanged) return;
    if (prev.size) {
      this.pushUndo(prev);
      this.redoStack = [];
    }
    this.changed(prev);
  }
}
