// Replays logged games to look for setup and map problems, plus per-model behavior.
// Usage: node scripts/analyze.ts runs/<batch> [runs/<batch> ...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adjudicate, centerCount, initialState, unitsOf, type State } from "../src/engine.ts";
import type { GameLog } from "../src/game.ts";
import { HOME, POWERS, PROVINCE_IDS, type Power } from "../src/map.ts";

const STAB = /(won't|will not|not) (attack|move (in)?to|touch|enter)|no aggression|non-aggression/i;

type ModelStats = { seats: number; share: number; wins: number; solos: number; attacks: number; promisedThenAttacked: number; foreignSupports: number; messages: number; fallbacks: number };
const models: Record<string, ModelStats> = {};
const blocked = { ownUnitAtHome: 0, enemyAtHome: 0, homeLost: 0 };
let builds = 0;
let games = 0;
let phases = 0;
let openingBounces = 0;
let deadSeatPhases = 0;
let leaderAt1903Won = 0;
let leaderAt1903Games = 0;
const soloYears: number[] = [];
const neutralAfter1901: number[] = [];

for (const dir of process.argv.slice(2)) {
  for (const file of readdirSync(dir).filter((f) => /^game-\d+\.json$/.test(f)).sort()) {
    const log = JSON.parse(readFileSync(join(dir, file), "utf8")) as GameLog;
    games++;
    let state: State = initialState();
    let leader1903: Power[] = [];
    for (const phase of log.phases) {
      phases++;
      const owner = Object.fromEntries(POWERS.flatMap((p) => (phase.orders[p] ?? []).map((o) => [o.unit, p])));
      deadSeatPhases += POWERS.filter((p) => unitsOf(state, p).length === 0).length;
      if (phase.phase === "S1901") openingBounces += POWERS.filter((p) => !phase.moved.includes(HOME[p]) && phase.orders[p]?.[0]?.action === "move").length;
      for (const p of POWERS) {
        const m = (models[log.seats[p]] ??= { seats: 0, share: 0, wins: 0, solos: 0, attacks: 0, promisedThenAttacked: 0, foreignSupports: 0, messages: 0, fallbacks: 0 });
        m.messages += phase.messages.filter((x) => x.from === p).length;
        m.fallbacks += phase.fallbacks.filter((f) => f.power === p).length;
        for (const o of phase.orders[p] ?? []) {
          if ((o.action === "support_hold" || o.action === "support_move") && owner[o.target] !== p) m.foreignSupports++;
          const victim = o.action === "move" ? owner[o.to] : undefined;
          if (victim && victim !== p) {
            m.attacks++;
            if (phase.messages.some((x) => x.from === p && x.to.includes(victim) && STAB.test(x.text))) m.promisedThenAttacked++;
          }
        }
      }
      const next = adjudicate(state, phase.orders).state;
      if (phase.phase.startsWith("F")) {
        // A power that could build but didn't: why?
        for (const p of POWERS) {
          if (unitsOf(next, p).length >= centerCount(next, p)) continue;
          const home = HOME[p];
          if (next.owners[home] !== p) blocked.homeLost++;
          else if (next.units[home] === p) blocked.ownUnitAtHome++;
          else if (next.units[home]) blocked.enemyAtHome++;
        }
        builds += phase.builds.length;
        if (phase.phase === "F1901") neutralAfter1901.push(PROVINCE_IDS.filter((c) => !next.owners[c]).length);
        if (phase.phase === "F1903") {
          const top = Math.max(...POWERS.map((p) => centerCount(next, p)));
          leader1903 = POWERS.filter((p) => centerCount(next, p) === top);
        }
      }
      state = next;
    }
    const result = log.final.result;
    if (result?.kind === "solo") soloYears.push(state.year);
    if (leader1903.length === 1) {
      leaderAt1903Games++;
      if (result?.winners.includes(leader1903[0] as Power)) leaderAt1903Won++;
    }
    for (const p of POWERS) {
      const m = models[log.seats[p]] as ModelStats;
      m.seats++;
      m.share += centerCount(log.final, p) / PROVINCE_IDS.length;
      if (result?.winners.includes(p) && result.kind !== "draw") m.wins++;
      if (result?.kind === "solo" && result.winners.includes(p)) m.solos++;
    }
  }
}

const r = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? r(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
console.log(`games ${games}, avg phases ${r(phases / games)}, solos ${soloYears.length} (avg year ${avg(soloYears)})`);
console.log(`unique 1903 leader went on to win: ${leaderAt1903Won}/${leaderAt1903Games}`);
console.log(`opening: ${r(openingBounces / games)} of 5 first moves bounce per game; ${avg(neutralAfter1901)} neutral centers left after 1901`);
console.log(`builds ${builds}; blocked builds: own unit at home ${blocked.ownUnitAtHome}, enemy at home ${blocked.enemyAtHome}, home lost ${blocked.homeLost}`);
console.log(`eliminated-seat phases: ${r(deadSeatPhases / games)} per game (out of ${r((phases / games) * 5)})`);
console.log("\nmodel          seats share wins solos attacks/g promised→attacked foreignSup/g msgs/g fallbacks");
for (const [id, m] of Object.entries(models).sort((a, b) => b[1].share / b[1].seats - a[1].share / a[1].seats)) {
  const per = (n: number) => r(n / m.seats);
  console.log(`${id.replace("claude-code/", "").padEnd(14)} ${String(m.seats).padEnd(5)} ${String(per(m.share)).padEnd(5)} ${String(m.wins).padEnd(4)} ${String(m.solos).padEnd(5)} ${String(per(m.attacks)).padEnd(9)} ${String(m.promisedThenAttacked).padEnd(17)} ${String(per(m.foreignSupports)).padEnd(12)} ${String(per(m.messages)).padEnd(6)} ${m.fallbacks}`);
}
