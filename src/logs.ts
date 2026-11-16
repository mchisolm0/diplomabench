import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GameLog } from "./game.ts";

/** Reads every `game-NN.json` in the given batch directories, filling fields older logs lack. */
export function loadLogs(dirs: readonly string[]): GameLog[] {
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => /^game-\d+\.json$/.test(f))
      .sort()
      .map((f) => {
        const log = JSON.parse(readFileSync(join(dir, f), "utf8")) as GameLog;
        log.map ??= "v1";
        log.final.map ??= log.map;
        for (const phase of log.phases) phase.disbands ??= [];
        return log;
      }),
  );
}
