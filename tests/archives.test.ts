import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { importAll } from "../src/import-archives.ts";
import { Storage } from "../src/storage.ts";
import type { CollectorConfig, FullSnapshot, LeaderboardConfig, Row } from "../src/types.ts";

const config: CollectorConfig = {
  api: "https://example.invalid",
  userAgent: "test",
  timeoutMs: 1000,
  pauseBetweenRequestsMs: 0,
  defaults: { idField: "name", volatileFields: ["rank", "change"], fullEveryMinutes: 360, fullIfChangedShareAbove: 0.6 },
  leaderboards: [],
};

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ rank: i + 1, name: `old${i}#0000`, fame: 1000 - i }));

describe("importAll", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "finals-hq-archives-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("fetches each frozen board once and skips it afterwards", async () => {
    const archives: LeaderboardConfig[] = [{ id: "cb1" }, { id: "ce44", kind: "community-event" }, { id: "s1", platform: "xbox" }];
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("/community-event/ce44")) {
        return new Response(JSON.stringify({ meta: {}, count: 2, data: { progress: { currentProgress: 1, goal: 2 }, entries: rows(2) } }), { status: 200 });
      }
      if (String(url).endsWith("/s1/xbox")) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ meta: {}, count: 3, data: rows(3) }), { status: 200 });
    }) as typeof fetch;
    const noSleep = async () => {};
    const options = { config, archives, storage: new Storage(root), fetchImpl, sleep: noSleep, log: () => {}, now: () => new Date("2026-11-06T01:00:00Z") };

    const first = await importAll(options);
    assert.deepEqual(first.map((r) => [r.key, r.outcome]), [["cb1", "archived"], ["ce44", "archived"], ["s1-xbox", "error"]]);
    assert.deepEqual(calls, [
      "https://example.invalid/v1/leaderboard/cb1",
      "https://example.invalid/v1/community-event/ce44",
      "https://example.invalid/v1/leaderboard/s1/xbox",
      "https://example.invalid/v1/leaderboard/s1/xbox",
      "https://example.invalid/v1/leaderboard/s1/xbox",
    ]);
    const files = await readdir(join(root, "seasons", "cb1"));
    assert.deepEqual(files, ["full-2026-11-06T01-00-00Z.json.gz"]);
    const snapshot = JSON.parse(gunzipSync(await readFile(join(root, "seasons", "cb1", files[0]))).toString("utf8")) as FullSnapshot;
    assert.equal(snapshot.type, "full");
    assert.equal(snapshot.key, "cb1");
    assert.equal(snapshot.rows.length, 3);
    const event = JSON.parse(gunzipSync(await readFile(join(root, "seasons", "ce44", (await readdir(join(root, "seasons", "ce44")))[0]))).toString("utf8")) as FullSnapshot;
    assert.equal(event.rows.length, 2);
    assert.deepEqual(event.meta, { meta: {}, count: 2, data: { progress: { currentProgress: 1, goal: 2 } } });

    const second = await importAll(options);
    assert.deepEqual(second.map((r) => [r.key, r.outcome]), [["cb1", "skipped"], ["ce44", "skipped"], ["s1-xbox", "error"]]);
    const log = (await readFile(join(root, "runs.log"), "utf8")).trim().split("\n");
    assert.equal(log.length, 4);
  });
});
