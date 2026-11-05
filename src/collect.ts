/**
 * FINALS HQ collector: one run = one request per configured leaderboard,
 * then either a full snapshot, a delta, or nothing (byte-identical answer).
 *
 *   node --experimental-strip-types src/collect.ts [--config config/leaderboards.json]
 *        [--root .] [--api https://...] [--now 2026-11-05T21:00:00Z] [--only s12-crossplay]
 *
 * Exit code 1 when at least one leaderboard failed; files for the others are still written.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { applyDelta, diffRows } from "./delta.ts";
import { fetchText, UpstreamError } from "./fetch.ts";
import { Storage, sha256, stamp } from "./storage.ts";
import type {
  CollectorConfig,
  DeltaSnapshot,
  FileRef,
  FullSnapshot,
  LeaderboardConfig,
  Manifest,
  Row,
  RunOutcome,
} from "./types.ts";
import { parseBody, ValidationError } from "./validate.ts";

export function leaderboardKey(lb: LeaderboardConfig): string {
  return lb.platform ? `${lb.id}-${lb.platform}` : lb.id;
}

export function leaderboardUrl(api: string, lb: LeaderboardConfig): string {
  const family = lb.kind === "community-event" ? "community-event" : "leaderboard";
  const platform = lb.platform ? `/${encodeURIComponent(lb.platform)}` : "";
  return `${api}/v1/${family}/${encodeURIComponent(lb.id)}${platform}`;
}

export interface CollectOptions {
  config: CollectorConfig;
  storage: Storage;
  /** Clock, injected for tests. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface CollectResult {
  key: string;
  outcome: RunOutcome;
  file?: string;
  message?: string;
}

async function rebuildState(storage: Storage, manifest: Manifest): Promise<Row[] | null> {
  if (!manifest.base) return null;
  const full = await storage.readSnapshot<FullSnapshot>(manifest.key, manifest.base.file);
  let rows = full.rows;
  for (const ref of manifest.deltas) {
    const delta = await storage.readSnapshot<DeltaSnapshot>(manifest.key, ref.file);
    rows = applyDelta(rows, delta, manifest.idField);
  }
  return rows;
}

function minutesBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}

export async function collectOne(lb: LeaderboardConfig, options: CollectOptions): Promise<CollectResult> {
  const { config, storage } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const key = leaderboardKey(lb);
  const idField = lb.idField ?? config.defaults.idField;
  const volatileFields = lb.volatileFields ?? config.defaults.volatileFields;
  const fullEveryMinutes = lb.fullEveryMinutes ?? config.defaults.fullEveryMinutes;
  const url = leaderboardUrl(config.api, lb);
  const at = (options.now ?? (() => new Date()))().toISOString();

  const previous = await storage.readManifest(key);
  const manifest: Manifest =
    previous && previous.idField === idField
      ? previous
      : { v: 1, key, idField, volatileFields, deltas: [] };
  if (previous && previous.idField !== idField) {
    log(`[${key}] idField changed (${previous.idField} -> ${idField}): starting a new base`);
    await storage.archiveState(key, []);
  }
  manifest.volatileFields = volatileFields;

  // Per-board cadence: a board polled hourly is skipped on the other runs (2 min of cron jitter tolerated).
  const everyMinutes = lb.everyMinutes ?? 0;
  if (manifest.lastSuccessAt && minutesBetween(manifest.lastSuccessAt, at) < everyMinutes - 2) {
    log(`[${key}] skipped (last success ${manifest.lastSuccessAt}, cadence ${everyMinutes} min)`);
    return { key, outcome: "skipped" };
  }

  const fail = async (outcome: "error", message: string, extra: { status?: number; body?: string } = {}) => {
    let errorFile: string | undefined;
    if (extra.body !== undefined) errorFile = await storage.writeErrorBody(key, at, extra.body);
    manifest.lastRun = { at, outcome, message };
    await storage.writeManifest(manifest);
    await storage.appendRunLog({ at, key, outcome, status: extra.status, message, file: errorFile });
    log(`[${key}] ERROR ${message}`);
    return { key, outcome, message, file: errorFile };
  };

  let fetched;
  try {
    fetched = await fetchText(url, {
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
    });
  } catch (error) {
    const status = error instanceof UpstreamError ? (error.status ?? undefined) : undefined;
    return fail("error", (error as Error).message, { status });
  }

  const bodyHash = sha256(fetched.body);
  if (manifest.lastRun?.sha256 === bodyHash && manifest.base) {
    manifest.lastRun = { at, outcome: "unchanged", sha256: bodyHash, count: manifest.lastRun.count };
    manifest.lastSuccessAt = at;
    await storage.writeManifest(manifest);
    await storage.appendRunLog({
      at, key, outcome: "unchanged", status: fetched.source.status,
      durationMs: fetched.source.durationMs, count: manifest.lastRun.count, sha256: bodyHash,
    });
    log(`[${key}] unchanged (same body as last run)`);
    return { key, outcome: "unchanged" };
  }

  let parsed;
  try {
    parsed = parseBody(fetched.body, idField);
  } catch (error) {
    const message = error instanceof ValidationError ? `validation: ${error.message}` : (error as Error).message;
    return fail("error", message, { status: fetched.source.status, body: fetched.body });
  }

  const previousRows = await rebuildState(storage, manifest);
  const baseAgeMinutes = manifest.base ? minutesBetween(manifest.base.at, at) : Infinity;
  let diff = previousRows ? diffRows(previousRows, parsed.rows, idField, volatileFields) : null;
  const changedShare = diff ? (diff.changed.length + diff.removed.length) / parsed.rows.length : 1;
  const wantFull =
    !previousRows || baseAgeMinutes >= fullEveryMinutes || changedShare > config.defaults.fullIfChangedShareAbove;

  if (wantFull || !diff) {
    const file = `full-${stamp(at)}.json.gz`;
    const snapshot: FullSnapshot = {
      v: 1, type: "full", key, idField, source: fetched.source, sha256: bodyHash,
      meta: parsed.meta, count: parsed.rows.length, rows: parsed.rows,
    };
    const bytes = await storage.writeSnapshot(key, file, snapshot);
    await storage.archiveState(key, [file]);
    const ref: FileRef = { file, at, sha256: bodyHash, count: parsed.rows.length };
    manifest.base = ref;
    manifest.deltas = [];
    manifest.lastRun = { at, outcome: "full", sha256: bodyHash, count: parsed.rows.length };
    manifest.lastSuccessAt = at;
    await storage.writeManifest(manifest);
    await storage.appendRunLog({
      at, key, outcome: "full", status: fetched.source.status, durationMs: fetched.source.durationMs,
      count: parsed.rows.length, changed: diff?.changed.length, removed: diff?.removed.length, file, bytes, sha256: bodyHash,
    });
    log(`[${key}] full snapshot: ${parsed.rows.length} rows, ${bytes} bytes -> ${file}`);
    return { key, outcome: "full", file };
  }

  const file = `delta-${stamp(at)}.json.gz`;
  const snapshot: DeltaSnapshot = {
    v: 1, type: "delta", key, idField, base: manifest.base!.file, seq: manifest.deltas.length + 1,
    source: fetched.source, sha256: bodyHash, meta: parsed.meta, count: parsed.rows.length,
    stats: diff.stats, changed: diff.changed, removed: diff.removed,
  };
  const bytes = await storage.writeSnapshot(key, file, snapshot);
  manifest.deltas.push({ file, at, sha256: bodyHash, count: parsed.rows.length });
  manifest.lastRun = { at, outcome: "delta", sha256: bodyHash, count: parsed.rows.length };
  manifest.lastSuccessAt = at;
  await storage.writeManifest(manifest);
  await storage.appendRunLog({
    at, key, outcome: "delta", status: fetched.source.status, durationMs: fetched.source.durationMs,
    count: parsed.rows.length, changed: diff.changed.length, removed: diff.removed.length, file, bytes, sha256: bodyHash,
  });
  log(`[${key}] delta: ${diff.changed.length} changed (${diff.stats.added} new), ${diff.removed.length} removed, ${bytes} bytes -> ${file}`);
  return { key, outcome: "delta", file };
}

export async function collectAll(options: CollectOptions, only?: string): Promise<CollectResult[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const results: CollectResult[] = [];
  const targets = options.config.leaderboards.filter((lb) => !only || leaderboardKey(lb) === only);
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(options.config.pauseBetweenRequestsMs);
    results.push(await collectOne(targets[i], options));
  }
  return results;
}

export async function loadConfig(path: string): Promise<CollectorConfig> {
  const config = JSON.parse(await readFile(path, "utf8")) as CollectorConfig;
  if (!config.api || !Array.isArray(config.leaderboards)) throw new Error(`invalid config: ${path}`);
  return config;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "config/leaderboards.json" },
      root: { type: "string", default: "." },
      api: { type: "string" },
      now: { type: "string" },
      only: { type: "string" },
    },
  });
  const config = await loadConfig(values.config!);
  if (values.api) config.api = values.api;
  const fixedNow = values.now ? new Date(values.now) : null;
  const results = await collectAll(
    { config, storage: new Storage(values.root!), now: fixedNow ? () => fixedNow : undefined },
    values.only,
  );
  const failed = results.filter((r) => r.outcome === "error");
  const skipped = results.filter((r) => r.outcome === "skipped");
  console.log(`done: ${results.length} leaderboards, ${skipped.length} skipped, ${failed.length} failed`);
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
