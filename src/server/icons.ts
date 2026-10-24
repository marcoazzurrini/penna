import fs from "node:fs";
import path from "node:path";

/** Lucide icon names and tags, loaded on first use. */
export class Icons {
  private names: string[] | null = null;
  private tags: Record<string, string[]> | null = null;
  /** Old names kept as aliases (e.g. "home" for "house"), mapped to the current name. */
  private aliases = new Map<string, string>();
  private dir: string;

  constructor(iconDir: string) {
    this.dir = iconDir;
  }

  private load(): string[] {
    return (this.names ??= fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".svg"))
      .map((f) => f.slice(0, -4)));
  }

  /** Tags and aliases cost a few hundred ms to read, so only searches load them. */
  private loadTags(): Record<string, string[]> {
    if (this.tags) return this.tags;
    const names = this.load();
    let tags: Record<string, string[]> = {};
    try {
      tags = JSON.parse(fs.readFileSync(path.join(this.dir, "..", "tags.json"), "utf8"));
    } catch {}
    // Alias files have no tags and the same markup as the icon they point to.
    if (Object.keys(tags).length) {
      const byMarkup = new Map<string, string>();
      const read = (n: string) => fs.readFileSync(path.join(this.dir, n + ".svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/class="[^"]*"/, "");
      for (const n of names) if (tags[n]) byMarkup.set(read(n), n);
      for (const n of names) {
        if (tags[n]) continue;
        const target = byMarkup.get(read(n));
        if (target) this.aliases.set(n, target);
      }
    }
    return (this.tags = tags);
  }

  has(name: string): boolean {
    return this.load().includes(name);
  }

  /** Icon names matching every word of `query`, best first. Names count more than tags. */
  search(query: string, limit = 12): string[] {
    const words = String(query).toLowerCase().split(/[\s_-]+/).filter(Boolean);
    if (!words.length) return [];
    const names = this.load();
    const allTags = this.loadTags();
    const scored = new Map<string, number>();
    for (const name of names) {
      if (this.aliases.has(name)) continue;
      const parts = name.split("-");
      const tags = allTags[name] ?? [];
      const joined = parts.join("");
      let total = 0;
      for (const w of words) {
        let s = 0;
        if (parts.includes(w)) s = 10;
        else if (tags[0] === w) s = 7;
        else if (tags.includes(w)) s = 6;
        else if (name.includes(w) || joined.includes(w)) s = 4;
        else if (tags.some((t) => t.includes(w))) s = 2;
        if (!s) {
          total = 0;
          break;
        }
        total += s;
      }
      if (name === words.join("-")) total += 20;
      if (total) scored.set(name, total);
    }
    // An old name, like "home", finds the icon it became.
    const alias = this.aliases.get(words.join("-"));
    if (alias) scored.set(alias, 100);
    return [...scored]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([n]) => n);
  }
}
