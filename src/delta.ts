import type { DeltaStats, Json, Row } from "./types.ts";

/** Deterministic JSON: object keys sorted, so equal values give equal strings. */
export function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as Json)}`).join(",")}}`;
}

/** The part of a row that matters for change detection. */
export function rowFingerprint(row: Row, volatileFields: readonly string[]): string {
  const copy: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (!volatileFields.includes(k)) copy[k] = v;
  }
  return stableStringify(copy);
}

export function rowId(row: Row, idField: string): string | null {
  const value = row[idField];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}

export interface IndexedRows {
  byId: Map<string, Row>;
  duplicateIds: number;
  /** Rows without a usable id. They are kept in full snapshots but cannot be diffed. */
  unidentified: Row[];
}

/** Index rows by id. On duplicates the first occurrence wins (lower rank first upstream). */
export function indexRows(rows: readonly Row[], idField: string): IndexedRows {
  const byId = new Map<string, Row>();
  const unidentified: Row[] = [];
  let duplicateIds = 0;
  for (const row of rows) {
    const id = rowId(row, idField);
    if (id === null) {
      unidentified.push(row);
      continue;
    }
    if (byId.has(id)) {
      duplicateIds++;
      continue;
    }
    byId.set(id, row);
  }
  return { byId, duplicateIds, unidentified };
}

export interface Diff {
  /** New rows in full; changed rows reduced to the id plus the fields whose value differs. */
  changed: Row[];
  removed: string[];
  stats: DeltaStats;
}

/** The id plus every field of `next` whose value differs from `prev` (volatile ones included). */
export function partialRow(prev: Row, next: Row, idField: string): Row {
  const partial: Row = { [idField]: next[idField] as Json };
  for (const [k, v] of Object.entries(next)) {
    if (k !== idField && stableStringify(prev[k] ?? null) !== stableStringify(v)) partial[k] = v;
  }
  return partial;
}

/**
 * Rows of `next` that are new or differ from `prev` once volatile fields are ignored,
 * plus ids of `prev` that are gone. Output order follows `next` (i.e. upstream rank order).
 * Changed rows are stored as partial rows: a player who only gained Rank Score costs
 * ~5 fields instead of 12, which keeps the repository small over months of 10-minute runs.
 */
export function diffRows(
  prev: readonly Row[],
  next: readonly Row[],
  idField: string,
  volatileFields: readonly string[],
): Diff {
  const before = indexRows(prev, idField);
  const after = indexRows(next, idField);
  const changed: Row[] = [];
  let added = 0;
  let unchanged = 0;
  for (const [id, row] of after.byId) {
    const old = before.byId.get(id);
    if (old === undefined) {
      added++;
      changed.push(row);
    } else if (rowFingerprint(old, volatileFields) !== rowFingerprint(row, volatileFields)) {
      changed.push(partialRow(old, row, idField));
    } else {
      unchanged++;
    }
  }
  const removed: string[] = [];
  for (const id of before.byId.keys()) {
    if (!after.byId.has(id)) removed.push(id);
  }
  return {
    changed,
    removed,
    stats: {
      changed: changed.length - added,
      added,
      removed: removed.length,
      unchanged,
      duplicateIds: after.duplicateIds,
    },
  };
}

/**
 * Rebuild the state after a delta: removed ids are dropped, changed rows are merged field by
 * field into the existing row (new ids are inserted as-is). Applying a delta twice is harmless.
 */
export function applyDelta(
  rows: readonly Row[],
  delta: { changed: readonly Row[]; removed: readonly string[] },
  idField: string,
): Row[] {
  const { byId, unidentified } = indexRows(rows, idField);
  for (const id of delta.removed) byId.delete(id);
  for (const row of delta.changed) {
    const id = rowId(row, idField);
    if (id === null) continue;
    const existing = byId.get(id);
    byId.set(id, existing ? { ...existing, ...row } : row);
  }
  return [...byId.values(), ...unidentified];
}
