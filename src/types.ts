/**
 * Shared types for the FINALS HQ collector.
 *
 * Rows are stored exactly as the upstream API returns them (no renaming, no
 * derived values): the collector's job is to preserve evidence, not to interpret it.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One leaderboard entry, verbatim from the API. */
export type Row = { [key: string]: Json };

export interface LeaderboardConfig {
  /** Upstream id, e.g. "s12" or "ce44". */
  id: string;
  /** Upstream platform segment, e.g. "crossplay". Omitted when the upstream has none. */
  platform?: string;
  /** Which endpoint family to call. Default: "leaderboard". */
  kind?: "leaderboard" | "community-event";
  /** Field that identifies a row across snapshots. Default: config.defaults.idField. */
  idField?: string;
  /** Fields ignored when deciding whether a row changed (ranks shift because of others). */
  volatileFields?: string[];
  /** Take a new full snapshot when the current base is older than this. */
  fullEveryMinutes?: number;
  /** Skip the leaderboard when its last successful run is younger than this (cadence per board). */
  everyMinutes?: number;
  /** Free text, for humans. */
  note?: string;
}

export interface CollectorConfig {
  /** Base URL of the upstream API, without trailing slash. */
  api: string;
  userAgent: string;
  timeoutMs: number;
  /** Pause between two upstream requests, to stay polite. */
  pauseBetweenRequestsMs: number;
  defaults: {
    idField: string;
    volatileFields: string[];
    fullEveryMinutes: number;
    /** Above this share of changed rows, a full snapshot is cheaper than a delta. */
    fullIfChangedShareAbove: number;
  };
  leaderboards: LeaderboardConfig[];
}

export interface SourceInfo {
  url: string;
  fetchedAt: string;
  status: number;
  durationMs: number;
  /** A whitelisted subset of response headers (cache state, freshness, size). */
  headers: { [name: string]: string };
}

export interface FullSnapshot {
  v: 1;
  type: "full";
  key: string;
  idField: string;
  source: SourceInfo;
  /** SHA-256 of the raw response body, to detect byte-identical answers. */
  sha256: string;
  /** Everything the API returned next to the rows (e.g. a `meta` object), or null. */
  meta: Json;
  count: number;
  rows: Row[];
}

export interface DeltaStats {
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
  duplicateIds: number;
}

export interface DeltaSnapshot {
  v: 1;
  type: "delta";
  key: string;
  idField: string;
  /** File name of the full snapshot this delta applies on top of (after earlier deltas). */
  base: string;
  /** 1-based position in the chain of deltas since `base`. */
  seq: number;
  source: SourceInfo;
  sha256: string;
  meta: Json;
  count: number;
  stats: DeltaStats;
  /**
   * New rows in full, and changed rows reduced to `idField` + the fields whose value differs
   * from the previous state (merge them into the previous row to rebuild it).
   */
  changed: Row[];
  /** Ids that disappeared from the leaderboard. */
  removed: string[];
}

export interface FileRef {
  file: string;
  at: string;
  sha256: string;
  count: number;
}

export interface Manifest {
  v: 1;
  key: string;
  idField: string;
  volatileFields: string[];
  base?: FileRef;
  deltas: FileRef[];
  lastRun?: {
    at: string;
    outcome: "full" | "delta" | "unchanged" | "error";
    sha256?: string;
    count?: number;
    message?: string;
  };
  /** Time of the last successful fetch (full, delta or unchanged), used for `everyMinutes`. */
  lastSuccessAt?: string;
}

export type RunOutcome = "full" | "delta" | "unchanged" | "skipped" | "error";

export interface RunLogLine {
  at: string;
  key: string;
  outcome: RunOutcome;
  status?: number;
  durationMs?: number;
  count?: number;
  changed?: number;
  removed?: number;
  file?: string;
  bytes?: number;
  sha256?: string;
  message?: string;
}
