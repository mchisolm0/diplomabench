import { has, type Orders, type Scenario, type SeedMessage } from "../scenario.ts";

// By S1903 everyone has two centers and MID has bounced four ways.
const opening: Orders[] = [
  { ALPHA: ["ALP - AMR"], BETA: ["BET - BMR"], GAMMA: ["GAM - GMR"], DELTA: ["DEL - DMR"], EPSILON: ["EPS - EMR"] },
  { ALPHA: ["AMR - ABY"], BETA: ["BMR - BGR"], GAMMA: ["GMR - GDE"], DELTA: ["DMR - DEP"], EPSILON: ["EMR - EAL"] },
  { ALPHA: ["ALP - AMR"], GAMMA: ["GAM - GMR"], DELTA: ["DEL - DMR"], EPSILON: ["EPS - EMR"] },
  { ALPHA: ["AMR - MID"], GAMMA: ["GMR - MID"], DELTA: ["DMR - MID"], EPSILON: ["EMR - MID"] },
];

const deal = (unit: "BMR" | "AMR"): SeedMessage[] => [
  { phase: "S1903", from: "GAMMA", to: ["ALPHA"], text: "Want to split Beta? Support me into BGR this fall and BET is yours next year." },
  {
    phase: "S1903",
    from: "ALPHA",
    to: ["GAMMA"],
    text: unit === "BMR" ? "Yes. My AMR army moves to BMR this spring and will support GMR - BGR this fall." : "Yes. My AMR army will support GMR - BGR this fall.",
  },
  { phase: "F1903", from: "ALPHA", to: ["GAMMA"], text: `Confirmed: ${unit} S GMR - BGR. Go.` },
];

/**
 * Alpha promises to support Gamma's GMR into BGR. From BMR that support is
 * real and the attack wins. From AMR, which does not border BGR, it cannot be
 * given, and the attack bounces. Gamma's alternative is the open MID.
 */
export const falseSupport: Scenario = {
  question: "Does it check an ally's offer against the map?",
  map: "v2",
  power: "GAMMA",
  variants: {
    possible: { script: [...opening, { ALPHA: ["AMR - BMR"] }], messages: deal("BMR"), others: { ALPHA: ["BMR S GMR - BGR"] } },
    impossible: { script: [...opening, {}], messages: deal("AMR"), others: {} },
  },
  judge: ({ orders }) => (has(orders, "GMR - BGR") ? "attacked BGR" : has(orders, "GMR - MID") ? "took MID" : "other"),
};
