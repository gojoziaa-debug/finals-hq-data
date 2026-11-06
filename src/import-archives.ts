/**
 * One-off download of the frozen leaderboards (past seasons, special boards, community events)
 * into seasons/<key>/full-<stamp>.json.gz, same file format as the collector's full snapshots.
 *
 *   node --experimental-strip-types src/import-archives.ts [--config config/leaderboards.json]
 *        [--archives config/archives.json] [--root .] [--only s11-crossplay]
 *
 * A key that already has a full file in seasons/ is skipped: frozen boards never change, so each
 * one is fetched exactly once. Exit code 1 when at least one download failed.
 */
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { leaderboardKey, leaderboardUrl, loadConfig } from "./collect.ts";
import { fetchText, UpstreamError } from "./fetch.ts";
import { Storage, sha256, stamp } from "./storage.ts";
import type { CollectorConfig, FullSnapshot, LeaderboardConfig } from "./types.ts";
import { parseBody, ValidationError } from "./validate.ts";

export interface ArchiveResult {
  key: string;
  outcome: "archived" | "skipped" | "error";
  file?: string;
  message?: string;
}

export interface ImportOptions {
  config: CollectorConfig;
  archives: LeaderboardConfig[];
  storage: Storage;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

async function hasFull(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((name) => /^full-.*\.json\.gz$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function importOne(lb: LeaderboardConfig, options: ImportOptions): Promise<ArchiveResult> {
  const { config, storage } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const key = leaderboardKey(lb);
  const dir = join(storage.root, "seasons", key);
  if (await hasFull(dir)) {
    log(`[${key}] skipped (already in seasons/)`);
    return { key, outcome: "skipped" };
  }
  const url = leaderboardUrl(config.api, lb);
  const at = (options.now ?? (() => new Date()))().toISOString();
  let fetched;
  try {
    fetched = await fetchText(url, { userAgent: config.userAgent, timeoutMs: config.timeoutMs, fetchImpl: options.fetchImpl, sleep: options.sleep });
  } catch (error) {
    const status = error instanceof UpstreamError ? (error.status ?? undefined) : undefined;
    await storage.appendRunLog({ at, key, outcome: "error", status, message: (error as Error).message });
    log(`[${key}] ERROR ${(error as Error).message}`);
    return { key, outcome: "error", message: (error as Error).message };
  }
  let parsed;
  try {
    parsed = parseBody(fetched.body, lb.idField ?? config.defaults.idField);
  } catch (error) {
    const message = error instanceof ValidationError ? `validation: ${error.message}` : (error as Error).message;
    const errorFile = await storage.writeErrorBody(key, at, fetched.body);
    await storage.appendRunLog({ at, key, outcome: "error", status: fetched.source.status, message, file: errorFile });
    log(`[${key}] ERROR ${message}`);
    return { key, outcome: "error", message };
  }
  const file = `full-${stamp(at)}.json.gz`;
  const snapshot: FullSnapshot = {
    v: 1, type: "full", key, idField: lb.idField ?? config.defaults.idField, source: fetched.source,
    sha256: sha256(fetched.body), meta: parsed.meta, count: parsed.rows.length, rows: parsed.rows,
  };
  await mkdir(dir, { recursive: true });
  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
  await writeFile(join(dir, file), compressed);
  await storage.appendRunLog({
    at, key, outcome: "full", status: fetched.source.status, durationMs: fetched.source.durationMs,
    count: parsed.rows.length, file: `seasons/${key}/${file}`, bytes: compressed.length, sha256: snapshot.sha256,
  });
  log(`[${key}] archived: ${parsed.rows.length} rows, ${compressed.length} bytes -> seasons/${key}/${file}`);
  return { key, outcome: "archived", file };
}

export async function importAll(options: ImportOptions, only?: string): Promise<ArchiveResult[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const results: ArchiveResult[] = [];
  const targets = options.archives.filter((lb) => !only || leaderboardKey(lb) === only);
  let fetches = 0;
  for (const lb of targets) {
    if (fetches > 0) await sleep(options.config.pauseBetweenRequestsMs);
    const result = await importOne(lb, options);
    if (result.outcome !== "skipped") fetches++;
    results.push(result);
  }
  return results;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "config/leaderboards.json" },
      archives: { type: "string", default: "config/archives.json" },
      root: { type: "string", default: "." },
      api: { type: "string" },
      only: { type: "string" },
    },
  });
  const config = await loadConfig(values.config);
  if (values.api) config.api = values.api;
  const archives = (JSON.parse(await readFile(values.archives, "utf8")) as { archives: LeaderboardConfig[] }).archives;
  const results = await importAll({ config, archives, storage: new Storage(values.root) }, values.only);
  const errors = results.filter((r) => r.outcome === "error");
  console.log(`done: ${results.filter((r) => r.outcome === "archived").length} archived, ${results.filter((r) => r.outcome === "skipped").length} skipped, ${errors.length} errors`);
  process.exit(errors.length > 0 ? 1 : 0);
}
