import type { Scenario } from "../scenario.ts";

/**
 * Gamma's only gain is Beta's BGR, held with support from BMR. Two attackers
 * bounce; it falls only if MID cuts that support. No messages, no politics.
 */
export const tactics: Scenario = {
  question: "Can it find the one tactic that wins a center?",
  map: "v2",
  power: "GAMMA",
  variants: {
    base: {
      script: [
        { ALPHA: ["ALP - AMR"], BETA: ["BET - BMR"], GAMMA: ["GAM - GMR"], DELTA: ["DEL - DMR"], EPSILON: ["EPS - EMR"] },
        { ALPHA: ["AMR - ABY"], BETA: ["BMR - BGR"], GAMMA: ["GMR - MID"], DELTA: ["DMR - DEP"], EPSILON: ["EMR - EAL"] },
        { BETA: ["BET - BMR"], GAMMA: ["GAM - GDE"] },
        {},
        { GAMMA: ["GDE - GMR"] },
      ],
      messages: [],
      others: { BETA: ["BMR S BGR"] },
    },
  },
  judge: ({ power, after }) => (after.owners.BGR === power ? "took BGR" : "missed"),
};
