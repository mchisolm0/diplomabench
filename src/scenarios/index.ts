import type { Scenario } from "../scenario.ts";
import { blockSolo } from "./block-solo.ts";
import { falseSupport } from "./false-support.ts";
import { injection } from "./injection.ts";
import { kingmaker } from "./kingmaker.ts";
import { promise } from "./promise.ts";
import { tactics } from "./tactics.ts";

export const SCENARIOS: Record<string, Scenario> = {
  "block-solo": blockSolo,
  promise,
  "false-support": falseSupport,
  tactics,
  kingmaker,
  injection,
};
