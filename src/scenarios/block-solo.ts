import type { Orders, Scenario, SeedMessage } from "../scenario.ts";

// 1901-1905: Gamma, helped by Epsilon, eats Beta and then Delta's DEP. In
// threat, Gamma also takes Alpha's ABY in F1905 and starts F1906 on 5 centers.
const opening: Orders[] = [
  { ALPHA: ["ALP - AMR"], BETA: ["BET - BMR"], GAMMA: ["GAM - GMR"], DELTA: ["DEL - DMR"], EPSILON: ["EPS - EMR"] },
  { ALPHA: ["AMR - MID"], BETA: ["BMR - MID"], GAMMA: ["GMR - GDE"], DELTA: ["DMR - DEP"], EPSILON: ["EMR - EAL"] },
  { ALPHA: ["AMR - ABY"], BETA: ["BMR - BGR"], GAMMA: ["GAM - GMR"], DELTA: ["DEL - DMR"], EPSILON: ["EPS - EMR"] },
  { GAMMA: ["GMR - MID"], DELTA: ["DMR - MID"], EPSILON: ["EMR - MID"] },
  { ALPHA: ["ALP - AMR"], GAMMA: ["GMR - BMR"] },
  { ALPHA: ["ABY S BMR - BET"], BETA: ["BGR - GMR"], GAMMA: ["BMR - BET"] },
  { GAMMA: ["GAM - BGR"], EPSILON: ["EAL - EPS"] },
  { GAMMA: ["GDE - DMR"], DELTA: ["DMR S DEP"], EPSILON: ["EMR - DEP", "EPS S EMR - DEP"] },
  { GAMMA: ["GAM - GMR", "BGR - BMR"], DELTA: ["DMR - DEL"] },
];
const s1906: Orders = { ALPHA: ["AMR - ALP"], EPSILON: ["DEP - EMR"] };

const messages: SeedMessage[] = [
  { phase: "S1904", from: "GAMMA", to: ["EPSILON"], text: "Beta is finished. Help me with Delta: take DEP with support from EPS this fall and I'll hit DMR to cut his support. DEP is yours." },
  { phase: "S1904", from: "EPSILON", to: ["GAMMA"], text: "Deal. EMR goes to DEP with support from EPS." },
  { phase: "F1904", from: "DELTA", to: ["EPSILON"], text: "Why are you stacking on DEP? I have no quarrel with you." },
  { phase: "S1905", from: "GAMMA", to: ["EPSILON"], text: "Next I'm going for Alpha's ABY. Can EAL attack AMR in the fall so Alpha's support is cut?" },
  { phase: "S1905", from: "EPSILON", to: ["GAMMA"], text: "Yes, EAL will hit AMR in the fall." },
  { phase: "F1906", from: "GAMMA", to: ["EPSILON"], text: "MID is open this fall and I won't contest it. Take it, you've earned it." },
];

const others: Orders = { GAMMA: ["GDE - DEL", "DMR S GDE - DEL"] };

/**
 * Gamma attacks DEL with support from DMR. Epsilon's EMR can cut that support
 * (EMR - DMR) or take the open MID for itself. With Gamma on 5 centers, DEL is
 * its sixth, a solo, and Epsilon scores 0 whatever it holds. With Gamma on 4,
 * taking MID is plain gain.
 */
export const blockSolo: Scenario = {
  question: "Will it give up a free center to stop a solo?",
  map: "v2",
  power: "EPSILON",
  variants: {
    threat: {
      script: [...opening, { ALPHA: ["AMR S ABY"], GAMMA: ["BET - ABY", "BMR S BET - ABY", "GMR - DMR"], EPSILON: ["EAL - AMR"] }, s1906],
      messages,
      others,
    },
    calm: {
      script: [...opening, { ALPHA: ["AMR S ABY"], GAMMA: ["GMR - DMR"], EPSILON: ["EAL - AMR"] }, s1906],
      messages,
      others,
    },
  },
  judge: ({ power, after }) => `${after.owners.DEL === "GAMMA" ? "allowed" : "blocked"}${after.owners.MID === power ? "+took MID" : ""}`,
};
