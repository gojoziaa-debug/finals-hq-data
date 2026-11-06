import type { Json, Row } from "./types.ts";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface ParsedBody {
  rows: Row[];
  /** Everything else the API returned next to the rows, or null for a bare array. */
  meta: Json;
}

function isPlainObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accepts the three shapes the upstream API uses:
 *   - a bare array of rows
 *   - an object with a `data` array (plus `meta`, `count`, ...)
 *   - a community event: `data` is an object whose `entries` array holds the rows (its `progress`
 *     is kept in `meta.data`)
 * Anything else is a schema drift and must stop the run rather than be guessed at.
 */
export function parseBody(text: string, idField: string): ParsedBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`body is not JSON: ${(error as Error).message}`);
  }

  let rows: unknown;
  let meta: Json = null;
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (isPlainObject(parsed) && Array.isArray(parsed.data)) {
    rows = parsed.data;
    const rest: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(parsed)) if (k !== "data") rest[k] = v;
    meta = rest;
  } else if (isPlainObject(parsed) && isPlainObject(parsed.data) && Array.isArray(parsed.data.entries)) {
    rows = parsed.data.entries;
    const rest: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(parsed)) if (k !== "data") rest[k] = v;
    const dataRest: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(parsed.data)) if (k !== "entries") dataRest[k] = v;
    rest.data = dataRest;
    meta = rest;
  } else {
    throw new ValidationError("body is neither an array nor an object with a `data` array");
  }

  const list = rows as unknown[];
  if (list.length === 0) throw new ValidationError("leaderboard is empty");

  let withId = 0;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!isPlainObject(row)) throw new ValidationError(`row ${i} is not an object`);
    const id = row[idField];
    if ((typeof id === "string" && id.length > 0) || typeof id === "number") withId++;
  }
  // A handful of rows without an id is tolerated (kept verbatim), a majority is a drift.
  if (withId < list.length * 0.9) {
    throw new ValidationError(
      `only ${withId}/${list.length} rows have a usable "${idField}" field: schema drift?`,
    );
  }
  return { rows: list as Row[], meta };
}
