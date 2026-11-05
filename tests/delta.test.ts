import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDelta, diffRows, indexRows, partialRow, rowFingerprint, stableStringify } from "../src/delta.ts";
import type { Row } from "../src/types.ts";

const volatile = ["rank", "change"];

const row = (name: string, rank: number, rankScore: number, extra: Row = {}): Row => ({
  rank, change: 0, name, rankScore, league: "Diamond 1", ...extra,
});

describe("stableStringify", () => {
  it("sorts keys recursively", () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});

describe("rowFingerprint", () => {
  it("ignores volatile fields only", () => {
    assert.equal(rowFingerprint(row("A", 1, 100), volatile), rowFingerprint(row("A", 2, 100, { change: 5 }), volatile));
    assert.notEqual(rowFingerprint(row("A", 1, 100), volatile), rowFingerprint(row("A", 1, 101), volatile));
  });
});

describe("indexRows", () => {
  it("keeps the first duplicate and counts the others", () => {
    const index = indexRows([row("A", 1, 100), row("A", 2, 90), row("B", 3, 80)], "name");
    assert.equal(index.byId.size, 2);
    assert.equal(index.duplicateIds, 1);
    assert.equal(index.byId.get("A")?.rank, 1);
  });
  it("sets aside rows without id", () => {
    const index = indexRows([row("A", 1, 100), { rank: 2, rankScore: 5 }], "name");
    assert.equal(index.unidentified.length, 1);
  });
});

describe("partialRow", () => {
  it("keeps the id and only the fields that differ, volatile ones included", () => {
    const prev = row("A", 2, 100, { clubTag: "" });
    const next = row("A", 1, 120, { clubTag: "HQ", change: 20 });
    assert.deepEqual(partialRow(prev, next, "name"), { name: "A", rank: 1, change: 20, rankScore: 120, clubTag: "HQ" });
  });
  it("treats a new field as a change", () => {
    assert.deepEqual(partialRow({ name: "A" }, { name: "A", league: "Ruby" }, "name"), { name: "A", league: "Ruby" });
  });
});

describe("diffRows", () => {
  it("detects changed, added, removed and ignores rank-only shifts", () => {
    const prev = [row("A", 1, 100), row("B", 2, 90), row("C", 3, 80)];
    const next = [row("B", 1, 95), row("A", 2, 100), row("D", 3, 70)];
    const diff = diffRows(prev, next, "name", volatile);
    assert.deepEqual(diff.changed, [{ name: "B", rank: 1, rankScore: 95 }, row("D", 3, 70)]);
    assert.deepEqual(diff.removed, ["C"]);
    assert.deepEqual(diff.stats, { changed: 1, added: 1, removed: 1, unchanged: 1, duplicateIds: 0 });
  });
  it("is empty when nothing but ranks moved", () => {
    const prev = [row("A", 1, 100), row("B", 2, 90)];
    const next = [row("B", 1, 90), row("A", 2, 100)];
    const diff = diffRows(prev, next, "name", volatile);
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.removed.length, 0);
  });
});

describe("applyDelta", () => {
  it("rebuilds the exact same state as the next snapshot", () => {
    const prev = [row("A", 1, 100), row("B", 2, 90), row("C", 3, 80)];
    const next = [row("B", 1, 95), row("A", 2, 100), row("D", 3, 70)];
    const diff = diffRows(prev, next, "name", volatile);
    const rebuilt = applyDelta(prev, diff, "name");
    const byName = (rows: Row[]) => new Map(rows.map((r) => [r.name as string, stableStringify(r)]));
    // Changed and new players are exact, ranks included; an untouched player keeps its previous
    // row (its rank is refreshed by the next full snapshot, or recomputed from scores).
    const expected = byName(next.filter((r) => r.name !== "A"));
    expected.set("A", stableStringify(row("A", 1, 100)));
    assert.deepEqual(byName(rebuilt), expected);
    // Applying the same delta twice changes nothing.
    assert.deepEqual(byName(applyDelta(rebuilt, diff, "name")), expected);
  });
});
