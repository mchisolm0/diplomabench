import { expect, test } from "vitest";
import { POWERS, PROVINCES, type Province } from "./map.ts";

const ids = Object.keys(PROVINCES) as Province[];

test("adjacency is symmetric and only names real provinces", () => {
  for (const id of ids) {
    for (const next of PROVINCES[id].adjacent) {
      expect(ids).toContain(next);
      expect(PROVINCES[next].adjacent).toContain(id);
    }
  }
});

test("every power has exactly one home", () => {
  for (const power of POWERS) {
    expect(ids.filter((id) => PROVINCES[id].home === power)).toHaveLength(1);
  }
});
