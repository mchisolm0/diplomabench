export const POWERS = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON"] as const;
export type Power = (typeof POWERS)[number];
export type Province = string;

export const FIRST_YEAR = 1901;

/** A board plus the few rules that vary with it. */
export type GameMap = {
  description: string;
  /** Where builds may go: only home centers, or any owned center. */
  builds: "home" | "owned";
  soloCenters: number;
  lastYear: number;
  provinces: readonly Province[];
  centers: readonly Province[];
  names: Readonly<Record<Province, string>>;
  adjacent: Readonly<Record<Province, readonly Province[]>>;
  homes: Readonly<Record<Power, readonly Province[]>>;
};

type ProvinceDef = { name: string; adjacent: readonly Province[]; center?: false; home?: Power };

function defineMap(def: Pick<GameMap, "description" | "builds" | "soloCenters" | "lastYear"> & { provinces: Record<Province, ProvinceDef> }): GameMap {
  const entries = Object.entries(def.provinces);
  return {
    ...def,
    provinces: entries.map(([id]) => id),
    centers: entries.filter(([, p]) => p.center !== false).map(([id]) => id),
    names: Object.fromEntries(entries.map(([id, p]) => [id, p.name])),
    adjacent: Object.fromEntries(entries.map(([id, p]) => [id, p.adjacent])),
    homes: Object.fromEntries(POWERS.map((power) => [power, entries.filter(([, p]) => p.home === power).map(([id]) => id)])) as Record<Power, Province[]>,
  };
}

// Five homes on a ring, a neutral frontier center between each pair of neighbors.
const ring = {
  ALP: { name: "Alpha Home", home: "ALPHA", adjacent: ["ABY", "EAL"] },
  BET: { name: "Beta Home", home: "BETA", adjacent: ["ABY", "BGR"] },
  GAM: { name: "Gamma Home", home: "GAMMA", adjacent: ["BGR", "GDE"] },
  DEL: { name: "Delta Home", home: "DELTA", adjacent: ["GDE", "DEP"] },
  EPS: { name: "Epsilon Home", home: "EPSILON", adjacent: ["DEP", "EAL"] },
} satisfies Record<Province, ProvinceDef>;

export const MAPS = {
  v1: defineMap({
    description: "11 provinces, all supply centers; builds only in the home center.",
    builds: "home",
    soloCenters: 6,
    lastYear: 1908,
    provinces: {
      ...ring,
      ABY: { name: "Amber Bay", adjacent: ["ALP", "BET", "EAL", "BGR", "MID"] },
      BGR: { name: "Bluegrass Reach", adjacent: ["BET", "GAM", "ABY", "GDE", "MID"] },
      GDE: { name: "Green Delta", adjacent: ["GAM", "DEL", "BGR", "DEP", "MID"] },
      DEP: { name: "Deep Pass", adjacent: ["DEL", "EPS", "GDE", "EAL", "MID"] },
      EAL: { name: "East Alpine Lowland", adjacent: ["EPS", "ALP", "DEP", "ABY", "MID"] },
      MID: { name: "Midlands", adjacent: ["ABY", "BGR", "GDE", "DEP", "EAL"] },
    },
  }),
  // v1's centers plus a ring of non-center marches between the homes and the
  // middle, so units can stand off centers and losing centers forces disbands.
  v2: defineMap({
    description: "v1's 11 centers plus 5 non-center marches; builds in any owned center.",
    builds: "owned",
    soloCenters: 6,
    lastYear: 1908,
    provinces: {
      ALP: { ...ring.ALP, adjacent: ["ABY", "EAL", "AMR"] },
      BET: { ...ring.BET, adjacent: ["ABY", "BGR", "BMR"] },
      GAM: { ...ring.GAM, adjacent: ["BGR", "GDE", "GMR"] },
      DEL: { ...ring.DEL, adjacent: ["GDE", "DEP", "DMR"] },
      EPS: { ...ring.EPS, adjacent: ["DEP", "EAL", "EMR"] },
      ABY: { name: "Amber Bay", adjacent: ["ALP", "BET", "AMR", "BMR"] },
      BGR: { name: "Bluegrass Reach", adjacent: ["BET", "GAM", "BMR", "GMR"] },
      GDE: { name: "Green Delta", adjacent: ["GAM", "DEL", "GMR", "DMR"] },
      DEP: { name: "Deep Pass", adjacent: ["DEL", "EPS", "DMR", "EMR"] },
      EAL: { name: "East Alpine Lowland", adjacent: ["EPS", "ALP", "EMR", "AMR"] },
      AMR: { name: "Alpha March", center: false, adjacent: ["ALP", "EAL", "ABY", "EMR", "BMR", "MID"] },
      BMR: { name: "Beta March", center: false, adjacent: ["BET", "ABY", "BGR", "AMR", "GMR", "MID"] },
      GMR: { name: "Gamma March", center: false, adjacent: ["GAM", "BGR", "GDE", "BMR", "DMR", "MID"] },
      DMR: { name: "Delta March", center: false, adjacent: ["DEL", "GDE", "DEP", "GMR", "EMR", "MID"] },
      EMR: { name: "Epsilon March", center: false, adjacent: ["EPS", "DEP", "EAL", "DMR", "AMR", "MID"] },
      MID: { name: "Midlands", adjacent: ["AMR", "BMR", "GMR", "DMR", "EMR"] },
    },
  }),
};

export type MapId = keyof typeof MAPS;
export const MAP_IDS = Object.keys(MAPS) as MapId[];

export function isAdjacent(map: GameMap, a: Province, b: Province): boolean {
  return map.adjacent[a]?.includes(b) ?? false;
}

/** Steps from `from` to the nearest of `targets`. */
export function distance(map: GameMap, from: Province, targets: readonly Province[]): number {
  let frontier = [from];
  const seen = new Set(frontier);
  for (let steps = 0; frontier.length; steps++) {
    if (frontier.some((p) => targets.includes(p))) return steps;
    frontier = frontier.flatMap((p) => map.adjacent[p] ?? []).filter((p) => !seen.has(p) && seen.add(p));
  }
  return Infinity;
}
