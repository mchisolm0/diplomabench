// Replays logged games to look for setup and map problems, plus per-model behavior.
// Usage: node scripts/analyze.ts runs/<batch> [runs/<batch> ...]
import { adjudicate, centerCount, initialState, scores, unitsOf, type State } from "../src/engine.ts";
import { loadLogs } from "../src/logs.ts";
import { MAPS, POWERS, type Power } from "../src/map.ts";

const STAB = /(won't|will not|not) (attack|move (in)?to|touch|enter)|no aggression|non-aggression/i;

type ModelStats = { seats: number; score: number; share: number; solos: number; attacks: number; promisedThenAttacked: number; foreignSupports: number; messages: number; fallbacks: number };
const models: Record<string, ModelStats> = {};
const blocked = { ownUnit: 0, enemyUnit: 0, noSite: 0 };
let builds = 0;
let disbands = 0;
let openingMoves = 0;
let games = 0;
let phases = 0;
let openingBounces = 0;
let deadSeatPhases = 0;
let leaderAt1903Top = 0;
let leaderAt1903Games = 0;
const soloYears: number[] = [];
const neutralAfter1901: number[] = [];

for (const log of loadLogs(process.argv.slice(2))) {
    const map = MAPS[log.map];
    games++;
    let state: State = initialState(log.map);
    let leader1903: Power[] = [];
    for (const phase of log.phases) {
      phases++;
      const owner = Object.fromEntries(POWERS.flatMap((p) => (phase.orders[p] ?? []).map((o) => [o.unit, p])));
      deadSeatPhases += POWERS.filter((p) => unitsOf(state, p).length === 0).length;
      if (phase.phase === "S1901") {
        const moves = POWERS.flatMap((p) => phase.orders[p] ?? []).filter((o) => o.action === "move");
        openingMoves += moves.length;
        openingBounces += moves.filter((o) => !phase.moved.includes(o.unit)).length;
      }
      for (const p of POWERS) {
        const m = (models[log.seats[p]] ??= { seats: 0, score: 0, share: 0, solos: 0, attacks: 0, promisedThenAttacked: 0, foreignSupports: 0, messages: 0, fallbacks: 0 });
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
        // Builds a power was owed but couldn't place: why?
        for (const p of POWERS) {
          const owed = centerCount(next, p) - unitsOf(next, p).length;
          if (owed <= 0) continue;
          const sites = map.centers.filter((c) => next.owners[c] === p && (map.builds === "owned" || map.homes[p].includes(c)));
          const reason = !sites.length ? "noSite" : sites.some((c) => next.units[c] === p) ? "ownUnit" : "enemyUnit";
          blocked[reason] += owed;
        }
        builds += phase.builds.length;
        disbands += phase.disbands.length;
        if (phase.phase === "F1901") neutralAfter1901.push(map.centers.filter((c) => !next.owners[c]).length);
        if (phase.phase === "F1903") {
          const top = Math.max(...POWERS.map((p) => centerCount(next, p)));
          leader1903 = POWERS.filter((p) => centerCount(next, p) === top);
        }
      }
      state = next;
    }
    const result = log.final.result;
    const score = scores(log.final);
    if (result?.kind === "solo") soloYears.push(state.year);
    const best = Math.max(...POWERS.map((p) => score[p]));
    const top = POWERS.filter((p) => score[p] === best);
    if (leader1903.length === 1) {
      leaderAt1903Games++;
      if (top.length === 1 && top[0] === leader1903[0]) leaderAt1903Top++;
    }
    for (const p of POWERS) {
      const m = models[log.seats[p]] as ModelStats;
      m.seats++;
      m.score += score[p];
      m.share += centerCount(log.final, p) / map.centers.length;
      if (result?.kind === "solo" && result.winners.includes(p)) m.solos++;
    }
}

const r = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? r(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
console.log(`games ${games}, avg phases ${r(phases / games)}, solos ${soloYears.length} (avg year ${avg(soloYears)})`);
console.log(`unique 1903 leader finished alone on top: ${leaderAt1903Top}/${leaderAt1903Games}`);
console.log(`opening: ${openingBounces}/${openingMoves} S1901 moves bounced; ${avg(neutralAfter1901)} neutral centers left after 1901`);
console.log(`builds ${builds}, disbands ${disbands}; builds owed but blocked: own unit on site ${blocked.ownUnit}, enemy on site ${blocked.enemyUnit}, no site owned ${blocked.noSite}`);
console.log(`eliminated-seat phases: ${r(deadSeatPhases / games)} per game (out of ${r((phases / games) * 5)})`);
console.log("\nmodel          seats score share solos attacks/g promised→attacked foreignSup/g msgs/g fallbacks");
for (const [id, m] of Object.entries(models).sort((a, b) => b[1].score / b[1].seats - a[1].score / a[1].seats)) {
  const per = (n: number) => r(n / m.seats);
  console.log(`${id.replace("claude-code/", "").padEnd(14)} ${String(m.seats).padEnd(5)} ${String(per(m.score)).padEnd(5)} ${String(per(m.share)).padEnd(5)} ${String(m.solos).padEnd(5)} ${String(per(m.attacks)).padEnd(9)} ${String(m.promisedThenAttacked).padEnd(17)} ${String(per(m.foreignSupports)).padEnd(12)} ${String(per(m.messages)).padEnd(6)} ${m.fallbacks}`);
}
