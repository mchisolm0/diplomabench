// Canonical mini_diplomacy_v1 board: five homes on a ring, a neutral frontier
// center between each pair of neighbors, and one contested center in the middle.
export const POWERS = ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON"] as const;
export type Power = (typeof POWERS)[number];

export const PROVINCES = {
  ALP: { name: "Alpha Home", home: "ALPHA", adjacent: ["ABY", "EAL"] },
  BET: { name: "Beta Home", home: "BETA", adjacent: ["ABY", "BGR"] },
  GAM: { name: "Gamma Home", home: "GAMMA", adjacent: ["BGR", "GDE"] },
  DEL: { name: "Delta Home", home: "DELTA", adjacent: ["GDE", "DEP"] },
  EPS: { name: "Epsilon Home", home: "EPSILON", adjacent: ["DEP", "EAL"] },
  ABY: { name: "Amber Bay", home: null, adjacent: ["ALP", "BET", "EAL", "BGR", "MID"] },
  BGR: { name: "Bluegrass Reach", home: null, adjacent: ["BET", "GAM", "ABY", "GDE", "MID"] },
  GDE: { name: "Green Delta", home: null, adjacent: ["GAM", "DEL", "BGR", "DEP", "MID"] },
  DEP: { name: "Deep Pass", home: null, adjacent: ["DEL", "EPS", "GDE", "EAL", "MID"] },
  EAL: { name: "East Alpine Lowland", home: null, adjacent: ["EPS", "ALP", "DEP", "ABY", "MID"] },
  MID: { name: "Midlands", home: null, adjacent: ["ABY", "BGR", "GDE", "DEP", "EAL"] },
} as const satisfies Record<string, { name: string; home: Power | null; adjacent: readonly string[] }>;

export type Province = keyof typeof PROVINCES;

export const SOLO_CENTERS = 6;
export const LAST_YEAR = 1908;
