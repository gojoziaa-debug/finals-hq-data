import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DeltaSnapshot, FullSnapshot, Manifest, RunLogLine } from "./types.ts";

/**
 * Layout (all paths relative to the repository root):
 *   state/<key>/manifest.json            small, rewritten every run
 *   state/<key>/full-<stamp>.json.gz      the current base snapshot
 *   state/<key>/delta-<stamp>.json.gz     deltas since that base
 *   archive/<key>/YYYY/MM/DD/...          previous bases and their deltas, moved as-is
 *   runs.log                              one JSON line per leaderboard per run
 *   errors/<key>-<stamp>.txt              raw bodies that failed validation
 *
 * Keeping the working set in `state/` lets a future sparse checkout skip `archive/`.
 */

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** "2026-11-05T21:03:12.345Z" -> "2026-11-05T21-03-12Z" (safe on every filesystem). */
export function stamp(at: string): string {
  return at.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function dateFolder(fileName: string): string {
  const match = /(\d{4})-(\d{2})-(\d{2})T/.exec(fileName);
  if (!match) throw new Error(`no date in file name: ${fileName}`);
  return join(match[1], match[2], match[3]);
}

export class Storage {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  stateDir(key: string): string {
    return join(this.root, "state", key);
  }

  async readManifest(key: string): Promise<Manifest | null> {
    try {
      const text = await readFile(join(this.stateDir(key), "manifest.json"), "utf8");
      return JSON.parse(text) as Manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    const dir = this.stateDir(manifest.key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  async readSnapshot<T extends FullSnapshot | DeltaSnapshot>(key: string, file: string): Promise<T> {
    const buffer = await readFile(join(this.stateDir(key), file));
    return JSON.parse(gunzipSync(buffer).toString("utf8")) as T;
  }

  /** Returns the number of bytes written (compressed). */
  async writeSnapshot(key: string, file: string, snapshot: FullSnapshot | DeltaSnapshot): Promise<number> {
    const dir = this.stateDir(key);
    await mkdir(dir, { recursive: true });
    const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
    await writeFile(join(dir, file), compressed);
    return compressed.length;
  }

  /** Moves every full/delta file of `state/<key>` into the archive, except `keep`. */
  async archiveState(key: string, keep: readonly string[]): Promise<string[]> {
    const dir = this.stateDir(key);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const moved: string[] = [];
    for (const name of entries) {
      if (!/^(full|delta)-.*\.json\.gz$/.test(name) || keep.includes(name)) continue;
      const target = join(this.root, "archive", key, dateFolder(name));
      await mkdir(target, { recursive: true });
      await rename(join(dir, name), join(target, name));
      moved.push(join("archive", key, dateFolder(name), name));
    }
    return moved;
  }

  async appendRunLog(line: RunLogLine): Promise<void> {
    await appendFile(join(this.root, "runs.log"), JSON.stringify(line) + "\n");
  }

  async writeErrorBody(key: string, at: string, body: string): Promise<string> {
    const dir = join(this.root, "errors");
    await mkdir(dir, { recursive: true });
    const file = `${key}-${stamp(at)}.txt`;
    await writeFile(join(dir, file), body.slice(0, 200_000));
    return join("errors", file);
  }
}
