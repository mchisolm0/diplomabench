import { describe, expect, test } from "vitest";
import { MAPS, MAP_IDS, POWERS } from "./map.ts";

describe.each(MAP_IDS)("map %s", (id) => {
  const map = MAPS[id];

  test("adjacency is symmetric and only names real provinces", () => {
    for (const p of map.provinces) {
      for (const next of map.adjacent[p] ?? []) {
        expect(map.provinces).toContain(next);
        expect(map.adjacent[next]).toContain(p);
      }
    }
  });

  test("every power has a home center, and a solo needs a majority", () => {
    for (const power of POWERS) {
      expect(map.homes[power].length).toBeGreaterThan(0);
      for (const home of map.homes[power]) expect(map.centers).toContain(home);
    }
    expect(map.soloCenters).toBeGreaterThan(map.centers.length / 2);
  });
});
