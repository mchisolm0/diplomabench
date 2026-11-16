import { describe, expect, test } from "vitest";
import {
  adjudicate,
  centerCount,
  initialState,
  legalOrders,
  normalizeOrders,
  scores,
  unitsOf,
  type Order,
  type State,
} from "./engine.ts";
import { MAP_IDS, POWERS, type Power, type Province } from "./map.ts";

type Setup = Partial<Record<Province, Power>>;

function board(units: Setup, extra: Partial<State> = {}): State {
  return { map: "v1", year: 1901, season: "S", units, owners: { ...units }, result: null, ...extra };
}

/** Plays one phase from compact orders, e.g. `{ ALPHA: ["ABY - MID"] }`. */
function play(state: State, given: Partial<Record<Power, string[]>>) {
  const orders: Partial<Record<Power, Order[]>> = {};
  for (const power of POWERS) orders[power] = normalizeOrders(state, power, given[power] ?? []).orders;
  return adjudicate(state, orders);
}

describe("orders", () => {
  test("illegal, foreign, duplicate, and missing orders become holds", () => {
    const s = board({ ABY: "ALPHA", BGR: "ALPHA", MID: "BETA" });
    const { orders, fallbacks } = normalizeOrders(s, "ALPHA", ["ABY - GDE", "MID H", "BGR - GDE", "BGR H"]);
    expect(orders).toEqual([
      { unit: "ABY", action: "hold" },
      { unit: "BGR", action: "move", to: "GDE" },
    ]);
    expect(fallbacks.map((f) => f.reason)).toEqual(["illegal", "not_your_unit", "duplicate"]);
    expect(normalizeOrders(s, "BETA", []).fallbacks).toEqual([{ power: "BETA", unit: "MID", reason: "missing" }]);
  });

  test("support move needs the supporter next to the destination", () => {
    const s = board({ ALP: "ALPHA", ABY: "BETA" });
    const legal = legalOrders(s, "ABY");
    expect(legal).toContainEqual({ unit: "ABY", action: "support_move", target: "ALP", to: "EAL" });
    expect(legal).not.toContainEqual({ unit: "ABY", action: "support_move", target: "ALP", to: "ABY" });
  });
});

describe("movement", () => {
  test("equal attacks into an empty province bounce", () => {
    const { state } = play(board({ ALP: "ALPHA", BET: "BETA" }), { ALPHA: ["ALP - ABY"], BETA: ["BET - ABY"] });
    expect(state.units).toEqual({ ALP: "ALPHA", BET: "BETA" });
  });

  test("a supported attack dislodges a holder; an unsupported one does not", () => {
    const s = board({ ABY: "ALPHA", BGR: "ALPHA", MID: "BETA" });
    expect(play(s, { ALPHA: ["ABY - MID"] }).state.units.MID).toBe("BETA");
    const { state, record } = play(s, { ALPHA: ["ABY - MID", "BGR S ABY - MID"] });
    expect(state.units).toEqual({ MID: "ALPHA", BGR: "ALPHA" });
    expect(record.dislodged).toEqual([{ unit: "MID", power: "BETA" }]);
  });

  test("hold support reaches units that are supporting, not ones that are moving", () => {
    const s = board({ ABY: "ALPHA", MID: "BETA", BGR: "BETA", GDE: "GAMMA", DEP: "GAMMA" });
    const supported = play(s, { BETA: ["MID S BGR", "BGR S MID"], GAMMA: ["GDE - MID", "DEP S GDE - MID"] });
    expect(supported.state.units.MID).toBe("BETA");
    const moving = play(s, { BETA: ["MID - EAL", "BGR S MID"], ALPHA: ["ABY - EAL"], GAMMA: ["GDE - MID", "DEP S GDE - MID"] });
    expect(moving.state.units.MID).toBe("GAMMA");
  });

  test("any foreign attack cuts support, even one that fails", () => {
    const s = board({ ABY: "ALPHA", BGR: "ALPHA", MID: "BETA", GDE: "GAMMA" });
    const { state } = play(s, { ALPHA: ["ABY - MID", "BGR S ABY - MID"], GAMMA: ["GDE - BGR"] });
    expect(state.units.MID).toBe("BETA");
  });

  test("the attacked province cannot cut support aimed at it without dislodging", () => {
    const s = board({ ABY: "ALPHA", BGR: "ALPHA", MID: "BETA" });
    const { state } = play(s, { ALPHA: ["ABY - MID", "BGR S ABY - MID"], BETA: ["MID - BGR"] });
    expect(state.units).toEqual({ MID: "ALPHA", BGR: "ALPHA" });
  });

  test("head-to-head units never swap; the stronger side dislodges", () => {
    const s = board({ ABY: "ALPHA", MID: "BETA", BGR: "ALPHA" });
    expect(play(s, { ALPHA: ["ABY - MID"], BETA: ["MID - ABY"] }).state.units).toEqual(s.units);
    const { state } = play(s, { ALPHA: ["ABY - MID", "BGR S ABY - MID"], BETA: ["MID - ABY"] });
    expect(state.units).toEqual({ MID: "ALPHA", BGR: "ALPHA" });
  });

  test("a ring of three rotates, and one bounce stops the whole ring", () => {
    const s = board({ ABY: "ALPHA", BGR: "BETA", MID: "GAMMA", GDE: "DELTA" });
    const ring = { ALPHA: ["ABY - BGR"], BETA: ["BGR - MID"], GAMMA: ["MID - ABY"] };
    const { state, record } = play(s, ring);
    expect(state.units).toEqual({ BGR: "ALPHA", MID: "BETA", ABY: "GAMMA", GDE: "DELTA" });
    expect(record.ambiguous).toBe(false);
    expect(play(s, { ...ring, DELTA: ["GDE - MID"] }).state.units).toEqual(s.units);
  });

  test("a power cannot dislodge itself or be dislodged with its own support", () => {
    const own = board({ ABY: "ALPHA", BGR: "ALPHA", MID: "ALPHA" });
    expect(play(own, { ALPHA: ["ABY - MID", "BGR S ABY - MID"] }).state.units).toEqual(own.units);
    const help = board({ ABY: "ALPHA", BGR: "BETA", MID: "BETA" });
    expect(play(help, { ALPHA: ["ABY - MID"], BETA: ["BGR S ABY - MID"] }).state.units.MID).toBe("BETA");
  });

  // DATC 5.B.7: support for an attack on your own unit can't help dislodge you,
  // but it still counts as defend strength. Upstream `diplomacy` gets this wrong.
  test("own support for an attack on you still defends in a head-to-head", () => {
    const s = board({ ABY: "ALPHA", BET: "ALPHA", EAL: "ALPHA", BGR: "DELTA", MID: "GAMMA" });
    const { state } = play(s, {
      ALPHA: ["ABY - MID", "BET S MID - ABY", "EAL S MID - ABY"],
      DELTA: ["BGR S ABY - MID"],
      GAMMA: ["MID - ABY"],
    });
    expect(state.units).toEqual(s.units);
  });

  test("a unit may follow its own unit out of a province", () => {
    const s = board({ ABY: "ALPHA", MID: "ALPHA" });
    expect(play(s, { ALPHA: ["ABY - MID", "MID - GDE"] }).state.units).toEqual({ MID: "ALPHA", GDE: "ALPHA" });
  });
});

describe("fall", () => {
  test("occupied centers change hands and an owned, empty home builds", () => {
    const { state, record } = play(board({ ALP: "ALPHA" }, { season: "F" }), { ALPHA: ["ALP - ABY"] });
    expect(state.owners.ABY).toBe("ALPHA");
    expect(record.builds).toEqual([{ power: "ALPHA", unit: "ALP" }]);
    expect(state).toMatchObject({ season: "S", year: 1902 });
  });

  test("six centers after Fall is a solo", () => {
    const owners: Setup = { ALP: "ALPHA", ABY: "ALPHA", EAL: "ALPHA", MID: "ALPHA", BGR: "ALPHA" };
    const { state } = play(board({ DEP: "ALPHA" }, { season: "F", owners }), {});
    expect(state.result).toEqual({ kind: "solo", winners: ["ALPHA"] });
  });

  test("a solo scores 1 and leaves everyone else 0; otherwise centers are shared", () => {
    const owners: Setup = { ALP: "ALPHA", ABY: "ALPHA", EAL: "ALPHA", MID: "ALPHA", BGR: "ALPHA", BET: "BETA" };
    const solo = play(board({ DEP: "ALPHA" }, { season: "F", owners }), {}).state;
    expect(scores(solo)).toMatchObject({ ALPHA: 1, BETA: 0 });
    const limit = play(board({}, { season: "F", year: 1908, owners: { ALP: "ALPHA", ABY: "ALPHA", BET: "BETA" } }), {}).state;
    expect(limit.result).toEqual({ kind: "limit", winners: [] });
    expect(scores(limit)).toMatchObject({ ALPHA: 2 / 11, BETA: 1 / 11, GAMMA: 0 });
  });
});

describe("v2 map", () => {
  const v2 = (units: Setup, owners: Setup) => board(units, { map: "v2", season: "F", owners });

  test("marches are not centers, and builds use any empty owned center, nearest home first", () => {
    const { state, record } = play(v2({ ALP: "ALPHA" }, { ALP: "ALPHA", ABY: "ALPHA", MID: "ALPHA" }), { ALPHA: ["ALP - AMR"] });
    expect(state.owners.AMR).toBeUndefined();
    expect(record.builds).toEqual([
      { power: "ALPHA", unit: "ALP" },
      { power: "ALPHA", unit: "ABY" },
    ]);
  });

  test("a power with more units than centers disbands the ones farthest from home", () => {
    const { state, record } = play(v2({ ALP: "ALPHA", AMR: "ALPHA", BMR: "ALPHA" }, { ALP: "ALPHA" }), {});
    expect(record.disbands).toEqual([
      { power: "ALPHA", unit: "BMR" },
      { power: "ALPHA", unit: "AMR" },
    ]);
    expect(unitsOf(state, "ALPHA")).toEqual(["ALP"]);
  });
});

test.each(MAP_IDS)("random games on %s stay legal and end by the turn limit", (map) => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let game = 0; game < 50; game++) {
    let state = initialState(map);
    while (!state.result) {
      const orders: Partial<Record<Power, Order[]>> = {};
      for (const power of POWERS) {
        orders[power] = unitsOf(state, power).map((p) => {
          const legal = legalOrders(state, p);
          return legal[Math.floor(rand() * legal.length)] ?? { unit: p, action: "hold" };
        });
      }
      const { state: next, record } = adjudicate(state, orders);
      expect(record.ambiguous).toBe(false);
      if (state.season === "F") {
        for (const power of POWERS) {
          expect(unitsOf(next, power).length).toBeLessThanOrEqual(centerCount(next, power));
        }
      }
      state = next;
    }
    expect(state.year).toBeLessThanOrEqual(1908);
    expect(Object.values(scores(state)).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
  }
});
