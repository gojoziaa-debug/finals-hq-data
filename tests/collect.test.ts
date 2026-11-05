import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { collectAll, leaderboardUrl } from "../src/collect.ts";
import { fetchText } from "../src/fetch.ts";
import { Storage } from "../src/storage.ts";
import type { CollectorConfig, DeltaSnapshot, FullSnapshot, Manifest, Row } from "../src/types.ts";
import { parseBody } from "../src/validate.ts";

const config: CollectorConfig = {
  api: "https://example.invalid",
  userAgent: "test",
  timeoutMs: 1000,
  pauseBetweenRequestsMs: 0,
  defaults: { idField: "name", volatileFields: ["rank", "change"], fullEveryMinutes: 360, fullIfChangedShareAbove: 0.6 },
  leaderboards: [{ id: "s12", platform: "crossplay" }],
};

const makeRows = (n: number, mutate: (row: Row, i: number) => void = () => {}): Row[] =>
  Array.from({ length: n }, (_, i) => {
    const row: Row = { rank: i + 1, change: 0, name: `player${i}#0000`, rankScore: 50_000 - i * 10, league: "Ruby" };
    mutate(row, i);
    return row;
  });

/** A fake upstream whose answer we change between runs. */
function fakeFetch(answer: () => { status: number; body: string }): typeof fetch {
  return (async () => {
    const { status, body } = answer();
    return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
  }) as typeof fetch;
}

const noSleep = async () => {};

describe("leaderboardUrl", () => {
  it("builds the two endpoint families", () => {
    assert.equal(leaderboardUrl("https://api", { id: "s12", platform: "crossplay" }), "https://api/v1/leaderboard/s12/crossplay");
    assert.equal(leaderboardUrl("https://api", { id: "ce44", kind: "community-event" }), "https://api/v1/community-event/ce44");
  });
});

describe("parseBody", () => {
  it("accepts a bare array and an object with data", () => {
    assert.equal(parseBody(JSON.stringify(makeRows(3)), "name").rows.length, 3);
    const parsed = parseBody(JSON.stringify({ meta: { x: 1 }, count: 3, data: makeRows(3) }), "name");
    assert.equal(parsed.rows.length, 3);
    assert.deepEqual(parsed.meta, { meta: { x: 1 }, count: 3 });
  });
  it("rejects drifts instead of guessing", () => {
    assert.throws(() => parseBody("not json", "name"), /not JSON/);
    assert.throws(() => parseBody('{"foo":1}', "name"), /neither/);
    assert.throws(() => parseBody("[]", "name"), /empty/);
    assert.throws(() => parseBody(JSON.stringify(makeRows(10)), "embarkId"), /schema drift/);
  });
});

describe("fetchText", () => {
  it("retries on 503 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => (++calls === 1 ? { status: 503, body: "down" } : { status: 200, body: "[]" }));
    const result = await fetchText("https://x", { userAgent: "t", timeoutMs: 100, fetchImpl, sleep: noSleep });
    assert.equal(calls, 2);
    assert.equal(result.source.status, 200);
    assert.equal(result.source.headers["cache-control"], "max-age=60");
  });
  it("does not retry a 404", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => (calls++, { status: 404, body: "nope" }));
    await assert.rejects(fetchText("https://x", { userAgent: "t", timeoutMs: 100, fetchImpl, sleep: noSleep }), /HTTP 404/);
    assert.equal(calls, 1);
  });
});

describe("collectAll end to end", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "finals-hq-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let rows = makeRows(1000);
  let status = 200;
  const fetchImpl = fakeFetch(() => ({ status, body: JSON.stringify({ meta: { v: "s12" }, count: rows.length, data: rows }) }));
  let clock = new Date("2026-11-05T21:00:00.000Z");
  const run = () => collectAll({ config, storage: new Storage(root), now: () => clock, fetchImpl, sleep: noSleep, log: () => {} });
  const manifest = async () => JSON.parse(await readFile(join(root, "state/s12-crossplay/manifest.json"), "utf8")) as Manifest;

  it("writes a full snapshot on the first run", async () => {
    const [result] = await run();
    assert.equal(result.outcome, "full");
    const m = await manifest();
    assert.equal(m.base?.file, "full-2026-11-05T21-00-00Z.json.gz");
    assert.equal(m.base?.count, 1000);
    const full = await new Storage(root).readSnapshot<FullSnapshot>("s12-crossplay", m.base!.file);
    assert.equal(full.rows.length, 1000);
    assert.deepEqual(full.meta, { meta: { v: "s12" }, count: 1000 });
  });

  it("records 'unchanged' when the body is byte-identical, without a file", async () => {
    clock = new Date("2026-11-05T21:15:00.000Z");
    const [result] = await run();
    assert.equal(result.outcome, "unchanged");
    assert.equal((await manifest()).deltas.length, 0);
  });

  it("writes a delta with only the rows that really changed", async () => {
    clock = new Date("2026-11-05T21:30:00.000Z");
    rows = makeRows(1000, (row, i) => {
      if (i === 5) row.rankScore = 60_000; // played and won
      if (i === 999) row.name = "newcomer#1234"; // last place replaced
    });
    const [result] = await run();
    assert.equal(result.outcome, "delta");
    const m = await manifest();
    assert.equal(m.deltas.length, 1);
    const delta = await new Storage(root).readSnapshot<DeltaSnapshot>("s12-crossplay", m.deltas[0].file);
    assert.deepEqual(delta.changed[0], { name: "player5#0000", rankScore: 60_000 });
    assert.equal(delta.changed[1].name, "newcomer#1234");
    assert.equal(Object.keys(delta.changed[1]).length, 5, "a new row is stored in full");
    assert.deepEqual(delta.removed, ["player999#0000"]);
    assert.equal(delta.seq, 1);
    assert.equal(delta.base, m.base!.file);
  });

  it("keeps an error run out of the chain and saves the bad body", async () => {
    clock = new Date("2026-11-05T21:45:00.000Z");
    status = 200;
    const savedRows = rows;
    rows = [];
    const [result] = await run();
    assert.equal(result.outcome, "error");
    assert.match(result.message ?? "", /empty/);
    assert.equal((await manifest()).deltas.length, 1);
    assert.ok((await readdir(join(root, "errors"))).length === 1);
    rows = savedRows;
  });

  it("starts a new base after fullEveryMinutes and archives the old chain", async () => {
    clock = new Date("2026-11-06T03:30:00.000Z");
    rows = makeRows(1000, (row, i) => { if (i === 7) row.rankScore = 61_000; });
    const [result] = await run();
    assert.equal(result.outcome, "full");
    const m = await manifest();
    assert.equal(m.base?.file, "full-2026-11-06T03-30-00Z.json.gz");
    assert.equal(m.deltas.length, 0);
    const stateFiles = (await readdir(join(root, "state/s12-crossplay"))).filter((f) => f.endsWith(".gz"));
    assert.deepEqual(stateFiles, ["full-2026-11-06T03-30-00Z.json.gz"]);
    const archived = await readdir(join(root, "archive/s12-crossplay/2026/11/05"));
    assert.deepEqual(archived.sort(), ["delta-2026-11-05T21-30-00Z.json.gz", "full-2026-11-05T21-00-00Z.json.gz"]);
  });

  it("rebuilds the current state exactly from base + deltas", async () => {
    // Run one more delta so there is a chain, then check that rebuilding gives the upstream rows.
    clock = new Date("2026-11-06T03:40:00.000Z");
    rows = makeRows(1000, (row, i) => { if (i === 7) row.rankScore = 61_000; if (i === 8) row.rankScore = 61_500; });
    assert.equal((await run())[0].outcome, "delta");
    const m = await manifest();
    const storage = new Storage(root);
    const { applyDelta } = await import("../src/delta.ts");
    let state = (await storage.readSnapshot<FullSnapshot>("s12-crossplay", m.base!.file)).rows;
    for (const ref of m.deltas) state = applyDelta(state, await storage.readSnapshot<DeltaSnapshot>("s12-crossplay", ref.file), "name");
    const sorted = (list: Row[]) => [...list].sort((a, b) => (a.rank as number) - (b.rank as number));
    assert.deepEqual(sorted(state), sorted(rows));
  });

  it("logs one line per run", async () => {
    const lines = (await readFile(join(root, "runs.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.outcome), ["full", "unchanged", "delta", "error", "full", "delta"]);
  });
});

describe("per-board cadence", () => {
  it("skips a board polled hourly on the runs in between", async () => {
    const root = await mkdtemp(join(tmpdir(), "finals-hq-cadence-"));
    const hourly: CollectorConfig = { ...config, leaderboards: [{ id: "s12worldtour", platform: "crossplay", everyMinutes: 60 }] };
    const rows = makeRows(20);
    const fetchImpl = fakeFetch(() => ({ status: 200, body: JSON.stringify({ count: rows.length, data: rows }) }));
    let clock = new Date("2026-11-05T21:03:00.000Z");
    const run = () => collectAll({ config: hourly, storage: new Storage(root), now: () => clock, fetchImpl, sleep: noSleep, log: () => {} });
    assert.equal((await run())[0].outcome, "full");
    clock = new Date("2026-11-05T21:13:00.000Z");
    assert.equal((await run())[0].outcome, "skipped");
    clock = new Date("2026-11-05T22:02:00.000Z"); // 59 min later: within the 2 min jitter tolerance
    assert.equal((await run())[0].outcome, "unchanged");
    await rm(root, { recursive: true, force: true });
  });
});
